import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, Check, ChevronRight, CircleStop, Code2, ExternalLink,
  FolderGit2, GitPullRequest, LoaderCircle, MessageSquare, Pause, Play,
  Plus, RefreshCw, RotateCcw, Send, Server, Settings2, ShieldCheck, X,
} from "lucide-react";
import {
  LoomApiError, LoomClient, type HarnessEvent, type ProjectSummary,
  type RunSummary, type TenantStatus, type WorkspaceInfo,
} from "@loom/api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { deleteToken, loadToken, saveToken } from "./secure-store";

interface Profile {
  id: string;
  name: string;
  baseUrl: string;
  tenant: string;
}

const PROFILE_KEY = "loom.desktop.profiles.v1";
const CLIENT_ID = `desktop-${crypto.randomUUID()}`;
const TERMINAL = new Set(["passed", "failed", "error", "cancelled", "review_required", "deployment_required", "paused"]);

function readProfiles(): Profile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatError(error: unknown): string {
  if (error instanceof LoomApiError) return `${error.message} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

function runTime(run: RunSummary): string {
  const value = run.endedAt ?? run.startedAt;
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function App() {
  const [profiles, setProfiles] = useState<Profile[]>(readProfiles);
  const [profileId, setProfileId] = useState<string>(() => readProfiles()[0]?.id ?? "");
  const [showSettings, setShowSettings] = useState(readProfiles().length === 0);
  const [tokenDraft, setTokenDraft] = useState("");
  const [client, setClient] = useState<LoomClient | null>(null);
  const [status, setStatus] = useState<TenantStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [goal, setGoal] = useState("");
  const [comment, setComment] = useState("");
  const streamAbort = useRef<AbortController | null>(null);

  const profile = profiles.find((item) => item.id === profileId) ?? null;

  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
  }, [profiles]);

  const connect = useCallback(async (nextProfile = profile, nextToken?: string) => {
    if (!nextProfile) return;
    setLoading(true);
    setError("");
    try {
      const token = nextToken ?? await loadToken(nextProfile.id);
      if (!token) {
        setShowSettings(true);
        throw new Error("Enter an API token to connect this profile.");
      }
      const nextClient = new LoomClient({ baseUrl: nextProfile.baseUrl, token });
      const nextStatus = await nextClient.negotiate(nextProfile.tenant);
      const nextProjects = await nextClient.projects(nextProfile.tenant);
      setClient(nextClient);
      setStatus(nextStatus);
      setProjects(nextProjects);
      setProject((current) => current && nextProjects.some((item) => item.project === current)
        ? current
        : nextProjects[0]?.project ?? "");
      setShowSettings(false);
    } catch (nextError) {
      setClient(null);
      setStatus(null);
      setProjects([]);
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    if (profile) void connect(profile);
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRuns = useCallback(async () => {
    if (!client || !profile || !project) return;
    setLoading(true);
    try {
      const nextRuns = await client.runs(profile.tenant, project);
      setRuns(nextRuns);
      if (selected) setSelected(nextRuns.find((run) => run.runId === selected.runId) ?? selected);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }, [client, profile, project, selected]);

  useEffect(() => {
    setSelected(null);
    setEvents([]);
    void refreshRuns();
  }, [project, client]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    streamAbort.current?.abort();
    setEvents([]);
    setWorkspace(null);
    if (!client || !profile || !project || !selected) return;
    const controller = new AbortController();
    streamAbort.current = controller;
    void client.watchRunEvents(profile.tenant, project, selected.runId, {
      signal: controller.signal,
      reconnect: !TERMINAL.has(selected.status),
      onEvent: (event) => setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]),
    }).catch((nextError) => {
      if (!controller.signal.aborted) setError(formatError(nextError));
    });
    void client.workspace(profile.tenant, project, selected.runId)
      .then(setWorkspace)
      .catch((nextError) => setError(formatError(nextError)));
    return () => controller.abort();
  }, [client, profile, project, selected?.runId]);

  async function saveProfile() {
    const id = profile?.id ?? crypto.randomUUID();
    const next: Profile = {
      id,
      name: (profile?.name ?? "Loom").trim() || "Loom",
      baseUrl: (profile?.baseUrl ?? "http://127.0.0.1:8787").trim(),
      tenant: (profile?.tenant ?? "").trim(),
    };
    if (!next.tenant) return setError("Tenant is required.");
    if (tokenDraft) await saveToken(id, tokenDraft);
    setProfiles((current) => [...current.filter((item) => item.id !== id), next]);
    setProfileId(id);
    setTokenDraft("");
    await connect(next, tokenDraft || undefined);
  }

  function updateProfile(field: keyof Omit<Profile, "id">, value: string) {
    if (!profile) {
      const next = { id: crypto.randomUUID(), name: "Local Loom", baseUrl: "http://127.0.0.1:8787", tenant: "alice", [field]: value };
      setProfiles((current) => [...current, next]);
      setProfileId(next.id);
      return;
    }
    setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, [field]: value } : item));
  }

  async function removeProfile() {
    if (!profile) return;
    await deleteToken(profile.id);
    const next = profiles.filter((item) => item.id !== profile.id);
    setProfiles(next);
    setProfileId(next[0]?.id ?? "");
    setShowSettings(next.length === 0);
  }

  async function createRun() {
    if (!client || !profile || !project || !goal.trim()) return;
    setLoading(true);
    try {
      const run = await client.createRun({
        tenant: profile.tenant,
        project,
        goal: goal.trim(),
        clientRequestId: crypto.randomUUID(),
        reviewRequired: true,
      });
      setGoal("");
      setShowCreate(false);
      await refreshRuns();
      setSelected(run);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: "pause" | "cancel" | "resume" | "approve-review" | "reject-review" | "approve-deploy" | "reject-deploy") {
    if (!client || !profile || !selected) return;
    setLoading(true);
    try {
      if (action === "pause") await client.pause(profile.tenant, project, selected.runId, "Pause requested from Loom Desktop", CLIENT_ID);
      if (action === "cancel") await client.cancel(profile.tenant, project, selected.runId, "Requested from Loom Desktop", CLIENT_ID);
      if (action === "resume") await client.resume(profile.tenant, project, selected.runId, CLIENT_ID);
      if (action === "approve-review" || action === "reject-review") await client.review(profile.tenant, project, selected.runId, action.startsWith("approve") ? "approved" : "rejected", CLIENT_ID);
      if (action === "approve-deploy" || action === "reject-deploy") await client.deployment(profile.tenant, project, selected.runId, action.startsWith("approve") ? "approved" : "rejected", CLIENT_ID);
      await refreshRuns();
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function sendComment() {
    if (!client || !profile || !selected || !comment.trim()) return;
    try {
      await client.comment(profile.tenant, project, selected.runId, comment.trim(), CLIENT_ID);
      setComment("");
    } catch (nextError) {
      setError(formatError(nextError));
    }
  }

  const ideUrl = workspace?.executor?.ideUrl;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div><strong>Loom</strong><span>Desktop alpha</span></div></div>
        <nav className="profiles" aria-label="Server profiles">
          {profiles.map((item) => (
            <button key={item.id} className={item.id === profileId ? "profile active" : "profile"} onClick={() => setProfileId(item.id)}>
              <Server size={16}/><span>{item.name}</span>{item.id === profileId && <ChevronRight size={14}/>} 
            </button>
          ))}
        </nav>
        <button className="sidebar-action" onClick={() => { setProfileId(""); setShowSettings(true); }}><Plus size={16}/> Add server</button>
        <div className="sidebar-footer">
          <button className="icon-text" onClick={() => setShowSettings(true)}><Settings2 size={16}/> Connection</button>
          <div className={status?.readiness.ok ? "health ok" : "health"}><span/>{status ? (status.readiness.ok ? "Ready" : "Degraded") : "Offline"}</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">{profile?.tenant ?? "No tenant"}</span><h1>{project || "Workspace"}</h1></div>
          <div className="topbar-actions">
            {ideUrl && <button className="secondary" onClick={() => void openExternal(ideUrl)}><Code2 size={16}/> Open IDE <ExternalLink size={13}/></button>}
            <button className="icon-button" title="Refresh" onClick={() => void refreshRuns()}><RefreshCw size={17} className={loading ? "spin" : ""}/></button>
            <button className="primary" disabled={!client || !project} onClick={() => setShowCreate(true)}><Plus size={17}/> New run</button>
          </div>
        </header>

        {error && <div className="error-banner"><AlertCircle size={17}/><span>{error}</span><button onClick={() => setError("")}><X size={15}/></button></div>}

        <div className="workspace-grid">
          <section className="project-rail">
            <div className="section-title"><FolderGit2 size={16}/> Projects <span>{projects.length}</span></div>
            <div className="project-list">
              {projects.map((item) => <button key={item.project} className={item.project === project ? "project-row active" : "project-row"} onClick={() => setProject(item.project)}><span>{item.project}</span><ChevronRight size={14}/></button>)}
              {!projects.length && <div className="empty-small">No registered projects</div>}
            </div>
          </section>

          <section className="run-list-panel">
            <div className="section-title"><Activity size={16}/> Runs <span>{runs.length}</span></div>
            <div className="run-list">
              {runs.map((run) => (
                <button key={run.runId} className={selected?.runId === run.runId ? "run-row active" : "run-row"} onClick={() => setSelected(run)}>
                  <StatusDot status={run.status}/>
                  <span className="run-copy"><strong>{run.goal ?? run.runId}</strong><small>{runTime(run)}</small></span>
                  <span className={`status-label status-${run.status}`}>{run.status.replaceAll("_", " ")}</span>
                </button>
              ))}
              {!runs.length && <div className="empty-state"><Activity size={24}/><strong>No runs yet</strong><span>Start the first auditable agent run.</span></div>}
            </div>
          </section>

          <section className="detail-panel">
            {selected ? <>
              <div className="detail-header">
                <div><span className={`status-label status-${selected.status}`}>{selected.status.replaceAll("_", " ")}</span><h2>{selected.goal ?? "Run details"}</h2><code>{selected.runId}</code></div>
                <RunActions run={selected} onAction={runAction}/>
              </div>
              <div className="timeline" aria-live="polite">
                {events.map((event) => <EventRow key={event.seq} event={event}/>) }
                {!events.length && <div className="empty-state"><LoaderCircle size={22} className={!TERMINAL.has(selected.status) ? "spin" : ""}/><span>{TERMINAL.has(selected.status) ? "No event details loaded" : "Waiting for events"}</span></div>}
              </div>
              <div className="comment-box"><MessageSquare size={17}/><input value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void sendComment(); }} placeholder="Steer this run or leave review context"/><button title="Send comment" onClick={() => void sendComment()} disabled={!comment.trim()}><Send size={16}/></button></div>
            </> : <div className="empty-detail"><ShieldCheck size={34}/><h2>Select a run</h2><p>Inspect the durable timeline, intervene, and decide human gates here.</p></div>}
          </section>
        </div>
      </main>

      {showSettings && <div className="modal-backdrop"><div className="modal">
        <div className="modal-head"><div><span className="eyebrow">Secure connection</span><h2>{profile ? "Server profile" : "Add Loom server"}</h2></div><button className="icon-button" onClick={() => setShowSettings(false)}><X size={18}/></button></div>
        <label>Name<input value={profile?.name ?? "Local Loom"} onChange={(event) => updateProfile("name", event.target.value)}/></label>
        <label>Server URL<input value={profile?.baseUrl ?? "http://127.0.0.1:8787"} onChange={(event) => updateProfile("baseUrl", event.target.value)} spellCheck={false}/></label>
        <label>Tenant<input value={profile?.tenant ?? "alice"} onChange={(event) => updateProfile("tenant", event.target.value)} spellCheck={false}/></label>
        <label>API token<input type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder={profile ? "Stored in OS keychain; leave blank to keep" : "Required"}/></label>
        <p className="security-note"><ShieldCheck size={15}/> Tokens are stored in the operating system keychain, never localStorage.</p>
        <div className="modal-actions">{profile && <button className="danger-text" onClick={() => void removeProfile()}>Remove</button>}<span/><button className="secondary" onClick={() => setShowSettings(false)}>Cancel</button><button className="primary" onClick={() => void saveProfile()}><Check size={16}/> Save & connect</button></div>
      </div></div>}

      {showCreate && <div className="modal-backdrop"><div className="modal compact">
        <div className="modal-head"><div><span className="eyebrow">{project}</span><h2>Start an agent run</h2></div><button className="icon-button" onClick={() => setShowCreate(false)}><X size={18}/></button></div>
        <label>Goal<textarea value={goal} onChange={(event) => setGoal(event.target.value)} autoFocus placeholder="Describe a verifiable outcome"/></label>
        <p className="security-note"><GitPullRequest size={15}/> The first version requests human review by default.</p>
        <div className="modal-actions"><span/><button className="secondary" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary" disabled={!goal.trim()} onClick={() => void createRun()}><Play size={16}/> Start run</button></div>
      </div></div>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`}/>;
}

async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function RunActions({ run, onAction }: { run: RunSummary; onAction(action: "pause" | "cancel" | "resume" | "approve-review" | "reject-review" | "approve-deploy" | "reject-deploy"): void }) {
  if (run.status === "paused") return <button className="secondary" onClick={() => onAction("resume")}><RotateCcw size={15}/> Resume</button>;
  if (run.status === "review_required") return <div className="button-group"><button className="secondary" onClick={() => onAction("reject-review")}><X size={15}/> Reject</button><button className="primary" onClick={() => onAction("approve-review")}><Check size={15}/> Approve</button></div>;
  if (run.status === "deployment_required") return <div className="button-group"><button className="secondary" onClick={() => onAction("reject-deploy")}><X size={15}/> Reject</button><button className="primary" onClick={() => onAction("approve-deploy")}><ShieldCheck size={15}/> Deploy</button></div>;
  if (run.status === "running") return <div className="button-group"><button className="secondary" onClick={() => onAction("pause")}><Pause size={15}/> Pause</button><button className="secondary danger" onClick={() => onAction("cancel")}><CircleStop size={15}/> Cancel</button></div>;
  if (run.status === "queued") return <button className="secondary danger" onClick={() => onAction("cancel")}><CircleStop size={15}/> Cancel</button>;
  return null;
}

function EventRow({ event }: { event: HarnessEvent }) {
  const message = event.data && typeof event.data.message === "string"
    ? event.data.message
    : event.data && typeof event.data.command === "string"
      ? event.data.command
      : undefined;
  const icon = event.type.includes("error") ? <AlertCircle size={15}/> : event.type.includes("pause") ? <Pause size={15}/> : event.type.includes("finish") ? <Check size={15}/> : <Activity size={15}/>;
  return <div className="event-row"><div className={`event-icon event-${event.type}`}>{icon}</div><div><div className="event-meta"><strong>{event.type.replaceAll("_", " ")}</strong><span>#{event.seq}</span><time>{event.at ? new Date(event.at).toLocaleTimeString() : ""}</time></div>{message && <p>{message}</p>}</div></div>;
}
