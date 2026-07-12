import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Check, ClipboardList, Database, LoaderCircle, RefreshCw, Sparkles, UserCheck, X } from "lucide-react";
import { LoomApiError, type BrainSignalFeed, type LoomClient, type RunSummary, type VasCaseArtifacts, type VasLearningList, type VasReviewPackage, type VasReviewQueue } from "@loom/api";
import { cacheKey, isOfflineError, metadataCache } from "./cache";

interface InsightsWorkbenchProps {
  client: LoomClient;
  tenant: string;
  project: string;
  run: RunSummary;
  clientId: string;
  profileId: string;
  setFocus(focus: string): void;
  onError(error: unknown): void;
}

export function InsightsWorkbench({ client, tenant, project, run, clientId, profileId, setFocus, onError }: InsightsWorkbenchProps) {
  const [queue, setQueue] = useState<VasReviewQueue | null>(null);
  const [learnings, setLearnings] = useState<VasLearningList | null>(null);
  const [signals, setSignals] = useState<BrainSignalFeed | null>(null);
  const [caseId, setCaseId] = useState(() => runCaseId(run));
  const [artifacts, setArtifacts] = useState<VasCaseArtifacts | null>(null);
  const [reviewPackage, setReviewPackage] = useState<VasReviewPackage | null>(null);
  const [decision, setDecision] = useState<"approved" | "changes_requested">("approved");
  const [note, setNote] = useState("");
  const [corrections, setCorrections] = useState("");
  const [learningDraft, setLearningDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [vasAvailable, setVasAvailable] = useState(true);
  const [offline, setOffline] = useState(false);
  const queueKey = cacheKey(profileId, tenant, `vas-queue:${project}`);
  const learningKey = cacheKey(profileId, tenant, `vas-learnings:${project}`);
  const brainKey = cacheKey(profileId, tenant, `brain:${project}`);

  const selectedCase = useMemo(() => queue?.cases.find((item) => item.id === caseId), [queue, caseId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    let nextOffline = false;
    try {
      const nextSignals = await client.brainSignals(tenant, project, undefined, 0, 200);
      setSignals(nextSignals);
      metadataCache.set(brainKey, nextSignals);
    } catch (error) {
      const cached = metadataCache.get<BrainSignalFeed>(brainKey);
      if (cached && isOfflineError(error)) {
        setSignals(cached.value);
        nextOffline = true;
      } else {
        onError(error);
      }
    }

    try {
      const [nextQueue, nextLearnings] = await Promise.all([
        client.vasReviewQueue(tenant, project),
        client.vasLearnings(tenant, project),
      ]);
      setQueue(nextQueue);
      setLearnings(nextLearnings);
      setVasAvailable(true);
      metadataCache.set(queueKey, nextQueue);
      metadataCache.set(learningKey, nextLearnings);
      setCaseId((current) => current || nextQueue.cases[0]?.id || "");
    } catch (error) {
      if (error instanceof LoomApiError && (error.status === 400 || error.status === 404)) {
        setVasAvailable(false);
      } else {
        const cachedQueue = metadataCache.get<VasReviewQueue>(queueKey);
        const cachedLearnings = metadataCache.get<VasLearningList>(learningKey);
        if ((cachedQueue || cachedLearnings) && isOfflineError(error)) {
          setQueue(cachedQueue?.value ?? null);
          setLearnings(cachedLearnings?.value ?? null);
          nextOffline = true;
        } else {
          onError(error);
        }
      }
    } finally {
      setOffline(nextOffline);
      setLoading(false);
    }
  }, [client, tenant, project, brainKey, queueKey, learningKey, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const nextCaseId = runCaseId(run);
    if (nextCaseId) setCaseId(nextCaseId);
  }, [run.runId]);

  useEffect(() => {
    if (!caseId || !vasAvailable || offline) {
      setArtifacts(null);
      setReviewPackage(null);
      return;
    }
    setFocus(`vas:${caseId}`);
    setDecision("approved");
    setNote("");
    setCorrections("");
    setLearningDraft("");
    setLoading(true);
    void Promise.all([
      client.vasCaseArtifacts(tenant, project, caseId),
      client.vasReviewPackage(tenant, project, caseId),
    ]).then(([nextArtifacts, nextPackage]) => {
      setArtifacts(nextArtifacts);
      setReviewPackage(nextPackage);
      applyDraft(nextArtifacts.reviewDraft);
    }).catch(onError).finally(() => setLoading(false));
  }, [client, tenant, project, caseId, vasAvailable, offline, setFocus, onError]);

  async function updateClaim(action: "claim" | "release") {
    if (!caseId || offline) return;
    setLoading(true);
    try {
      await client.claimVasCase(tenant, project, caseId, action, clientId);
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function submitReview() {
    if (!caseId || offline) return;
    setLoading(true);
    try {
      await client.reviewVasCase(tenant, project, caseId, {
        decision,
        note: note.trim() || undefined,
        corrections: lines(corrections),
        learnings: lines(learningDraft),
        runId: runCaseId(run) === caseId ? run.runId : undefined,
        clientId,
      });
      setNote("");
      setCorrections("");
      setLearningDraft("");
      await refresh();
      const [nextArtifacts, nextPackage] = await Promise.all([
        client.vasCaseArtifacts(tenant, project, caseId),
        client.vasReviewPackage(tenant, project, caseId),
      ]);
      setArtifacts(nextArtifacts);
      setReviewPackage(nextPackage);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  function applyDraft(draft?: Record<string, unknown>) {
    if (!draft) return;
    if (typeof draft.note === "string") setNote(draft.note);
    const draftCorrections = draft.corrections;
    const draftLearnings = draft.learnings;
    if (Array.isArray(draftCorrections)) setCorrections(draftCorrections.filter((item): item is string => typeof item === "string").join("\n"));
    if (Array.isArray(draftLearnings)) setLearningDraft(draftLearnings.filter((item): item is string => typeof item === "string").join("\n"));
  }

  return <div className="workbench-pane insights-workbench">
    <div className="workbench-toolbar">
      <Brain size={15}/><strong>VAS & Brain</strong>
      {offline && <span className="offline-badge">Cached metadata · read only</span>}
      <span className="toolbar-spacer"/>
      <button className="icon-button compact-icon" title="Refresh insights" onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""}/></button>
    </div>
    <div className="insights-layout">
      <section className="insight-column queue-column">
        <div className="subsection-title"><ClipboardList size={14}/> Review queue <span>{queue?.cases.length ?? 0}</span></div>
        {!vasAvailable && <div className="empty-state compact-empty"><Database size={22}/><strong>VAS not enabled</strong><span>This project still exposes Brain signals.</span></div>}
        {vasAvailable && <div className="insight-list">
          {queue?.cases.map((item) => <button key={item.id} className={caseId === item.id ? "insight-row active" : "insight-row"} onClick={() => setCaseId(item.id)}>
            <strong>{item.title ?? item.id}</strong><span>{item.reasons.join(" · ")}</span><small>{item.runCount ?? 0} runs · {item.learningCount ?? 0} learnings</small>
          </button>)}
          {!queue?.cases.length && <div className="empty-small">Review queue is clear</div>}
        </div>}
        <div className="subsection-title learning-title"><Sparkles size={14}/> Learnings <span>{learnings?.learnings.length ?? 0}</span></div>
        <div className="insight-list learning-list">
          {learnings?.learnings.map((learning, index) => <div className="learning-row" key={`${learning.caseId}-${index}`}><strong>{learning.caseId}</strong><p>{learning.text}</p><small>{learning.reviewDecision ?? "recorded"} · {learning.actor ?? learning.clientId ?? "system"}</small></div>)}
        </div>
      </section>
      <section className="insight-column package-column">
        <div className="subsection-title"><UserCheck size={14}/> Case review</div>
        {selectedCase ? <>
          <div className="case-summary"><div><strong>{selectedCase.title ?? selectedCase.id}</strong><span>{selectedCase.status ?? "pending"}</span></div><div className="button-group"><button className="secondary compact-button" disabled={offline || loading} onClick={() => void updateClaim("release")}><X size={13}/> Release</button><button className="secondary compact-button" disabled={offline || loading} onClick={() => void updateClaim("claim")}><UserCheck size={13}/> Claim</button></div></div>
          <div className="case-metrics"><span>{reviewPackage?.runs.length ?? 0} runs</span><span>{reviewPackage?.reviews.length ?? 0} reviews</span><span>{reviewPackage?.corrections.length ?? 0} corrections</span><span>{reviewPackage?.learnings.length ?? 0} learnings</span></div>
          <label>Decision<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="approved">Approve</option><option value="changes_requested">Request changes</option></select></label>
          <label>Review note<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Evidence-backed decision"/></label>
          <div className="review-grid"><label>Corrections<textarea value={corrections} onChange={(event) => setCorrections(event.target.value)} placeholder="One correction per line"/></label><label>Learnings<textarea value={learningDraft} onChange={(event) => setLearningDraft(event.target.value)} placeholder="One learning per line"/></label></div>
          <button className="primary review-submit" disabled={offline || loading} onClick={() => void submitReview()}>{loading ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>} Record decision</button>
          <details className="artifact-details" open><summary>Artifacts</summary><div className="artifact-paths"><span>{artifacts?.contextPath ?? "context missing"}</span><span>{artifacts?.reportPath ?? "report missing"}</span><span>{artifacts?.reviewDraftPath ?? "draft missing"}</span></div><pre>{artifacts?.report ?? JSON.stringify(artifacts?.reviewDraft ?? {}, null, 2)}</pre></details>
        </> : <div className="empty-state compact-empty"><ClipboardList size={22}/><strong>Select a case</strong><span>Inspect evidence and record learning decisions.</span></div>}
      </section>
      <section className="insight-column brain-column">
        <div className="subsection-title"><Brain size={14}/> Brain signals <span>{signals?.count ?? 0}</span></div>
        <div className="insight-list brain-list">
          {signals?.signals.map((signal) => <div className="signal-row" key={signal.seq}><div><strong>{signal.source.replaceAll("_", " ")}</strong><span>#{signal.seq}</span></div><p>{signal.failureKind ?? signal.outcome ?? signal.path ?? signal.status ?? signal.runId ?? "Recorded evidence"}</p><small>{new Date(signal.ts).toLocaleString()} · {signal.actor ?? signal.clientId ?? "system"}</small>{signal.modelTotalTokens !== undefined && <small>{signal.modelTotalTokens} tokens{signal.modelCostUsd !== undefined ? ` · $${signal.modelCostUsd.toFixed(4)}` : ""}</small>}</div>)}
          {!signals?.signals.length && <div className="empty-small">No Brain signals for this project</div>}
        </div>
      </section>
    </div>
  </div>;
}

function runCaseId(run: RunSummary): string {
  const input = run.metadata?.runPresetInput;
  return isRecord(input) && typeof input.caseId === "string" ? input.caseId : "";
}

function lines(value: string): string[] | undefined {
  const result = value.split("\n").map((line) => line.trim()).filter(Boolean);
  return result.length ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
