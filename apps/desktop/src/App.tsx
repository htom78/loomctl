import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, Bug, Check, ChevronRight, CircleStop, Code2, Download,
  ExternalLink, Eye, FolderGit2, GitPullRequest, LogIn, Pause, Play, Plus,
  RefreshCw, RotateCcw, Server, Settings2, ShieldCheck, Undo2, X,
} from "lucide-react";
import {
  LoomApiError, LoomClient, type HarnessEvent, type ProjectSummary,
  type RunSummary, type TenantStatus, type WorkspaceInfo,
} from "@loom/api";
import { deleteToken, loadToken, saveToken } from "./secure-store";
import { cacheKey, isOfflineError, metadataCache } from "./cache";
import { RunWorkbench } from "./RunWorkbench";
import {
  beginOidcLogin, checkForUpdate, configureProfileTransport, installPendingUpdate,
  listenForOidcCallback, loadDiagnosticReport, loadRollbackMetadata, notify,
  openExternal, profileFetch, recordDiagnostic, submitPendingCrash,
  type DesktopDiagnosticReport, type DesktopUpdateInfo, type RollbackMetadata,
} from "./desktop-runtime";
import {
  readPreferences, readProfiles, writePreferences, writeProfiles,
  type Profile, type UpdateChannel,
} from "./profile-store";

const CLIENT_ID = `desktop-${crypto.randomUUID()}`;
const TERMINAL = new Set(["passed", "failed", "error", "cancelled", "review_required", "deployment_required", "paused"]);
const NOTIFICATION_EVENTS: Record<string, string> = {
  finish: "Run completed",
  error: "Run failed",
  verification_failed: "Verification failed",
  review_required: "Review required",
  deployment_required: "Deployment approval required",
};

function formatError(error: unknown): string {
  const value = error instanceof LoomApiError
    ? `${error.message} (${error.status})`
    : error instanceof Error ? error.message : String(error);
  return value.slice(0, 1000)
    .replace(/(bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
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
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => readPreferences().updateChannel);
  const [updateInfo, setUpdateInfo] = useState<DesktopUpdateInfo | null>(null);
  const [rollbackInfo, setRollbackInfo] = useState<RollbackMetadata | null>(null);
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnosticReport | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [client, setClient] = useState<LoomClient | null>(null);
  const [status, setStatus] = useState<TenantStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [offlineAt, setOfflineAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [goal, setGoal] = useState("");
  const streamAbort = useRef<AbortController | null>(null);
  const profilesRef = useRef(profiles);
  const connectRef = useRef<(nextProfile: Profile, nextToken?: string) => Promise<void>>(async () => undefined);

  const profile = profiles.find((item) => item.id === profileId) ?? null;

  useEffect(() => {
    writeProfiles(profiles);
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    writePreferences({ updateChannel });
  }, [updateChannel]);

  const connect = useCallback(async (nextProfile = profile, nextToken?: string) => {
    if (!nextProfile) return;
    setLoading(true);
    setError("");
    try {
      await configureProfileTransport(nextProfile.id, nextProfile.baseUrl, nextProfile.caPem);
      const token = nextToken ?? await loadToken(nextProfile.id);
      if (!token) {
        setShowSettings(true);
        throw new Error(nextProfile.authMode === "oidc"
          ? "Sign in with the configured identity provider."
          : "Enter an API token to connect this profile.");
      }
      const nextClient = new LoomClient({
        baseUrl: nextProfile.baseUrl,
        token,
        fetch: profileFetch(nextProfile.id),
      });
      try {
        const nextStatus = await nextClient.negotiate(nextProfile.tenant);
        const nextProjects = await nextClient.projects(nextProfile.tenant);
        setStatus(nextStatus);
        setProjects(nextProjects);
        metadataCache.set(cacheKey(nextProfile.id, nextProfile.tenant, "projects"), nextProjects);
        setProject((current) => current && nextProjects.some((item) => item.project === current)
          ? current
          : nextProjects[0]?.project ?? "");
        setOfflineAt("");
      } catch (nextError) {
        const cached = metadataCache.get<ProjectSummary[]>(cacheKey(nextProfile.id, nextProfile.tenant, "projects"));
        if (!cached || !isOfflineError(nextError)) throw nextError;
        setStatus(null);
        setProjects(cached.value);
        setProject((current) => current && cached.value.some((item) => item.project === current) ? current : cached.value[0]?.project ?? "");
        setOfflineAt(cached.storedAt);
        setError(`Offline metadata from ${new Date(cached.storedAt).toLocaleString()}`);
      }
      setClient(nextClient);
      setShowSettings(false);
      void recordDiagnostic("network").catch(() => undefined);
      if (nextProfile.crashReporting && nextProfile.crashEndpoint) {
        void submitPendingCrash(true, nextProfile.crashEndpoint, nextProfile.caPem)
          .catch((crashError) => setError(`Connected; crash report was not sent: ${formatError(crashError)}`));
      }
    } catch (nextError) {
      setClient(null);
      setStatus(null);
      setProjects([]);
      setError(formatError(nextError));
      void recordDiagnostic(nextProfile.authMode === "oidc" ? "auth" : "network").catch(() => undefined);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void listenForOidcCallback(
      (result) => {
        if (disposed) return;
        const authenticatedProfile = profilesRef.current.find((item) => item.id === result.profileId);
        if (authenticatedProfile) {
          setProfileId(result.profileId);
          void recordDiagnostic("auth").catch(() => undefined);
          void connectRef.current(authenticatedProfile);
        }
      },
      (nextError) => {
        if (!disposed) setError(formatError(nextError));
        void recordDiagnostic("auth").catch(() => undefined);
      },
    ).then((stop) => { unlisten = stop; }).catch((nextError) => setError(formatError(nextError)));
    return () => { disposed = true; unlisten(); };
  }, []);

  useEffect(() => {
    if (profile) void connect(profile);
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRuns = useCallback(async () => {
    if (!client || !profile || !project) return;
    setLoading(true);
    try {
      const nextRuns = await client.runs(profile.tenant, project);
      setRuns(nextRuns);
      metadataCache.set(cacheKey(profile.id, profile.tenant, `runs:${project}`), nextRuns);
      setOfflineAt("");
      if (selected) setSelected(nextRuns.find((run) => run.runId === selected.runId) ?? selected);
    } catch (nextError) {
      const cached = metadataCache.get<RunSummary[]>(cacheKey(profile.id, profile.tenant, `runs:${project}`));
      if (cached && isOfflineError(nextError)) {
        setRuns(cached.value);
        setOfflineAt(cached.storedAt);
        setError(`Offline metadata from ${new Date(cached.storedAt).toLocaleString()}`);
      } else {
        setError(formatError(nextError));
      }
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
      onEvent: (event) => {
        setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]);
        const title = NOTIFICATION_EVENTS[event.type];
        if (title) {
          void notify(title, selected.goal ?? selected.runId).catch(() => undefined);
          void refreshRuns();
        }
      },
    }).catch((nextError) => {
      if (!controller.signal.aborted) setError(formatError(nextError));
    });
    void client.workspace(profile.tenant, project, selected.runId)
      .then(setWorkspace)
      .catch((nextError) => setError(formatError(nextError)));
    return () => controller.abort();
  }, [client, profile, project, selected?.runId]);

  function profileDraft(): Profile {
    const id = profile?.id ?? crypto.randomUUID();
    return {
      id,
      name: (profile?.name ?? "Loom").trim() || "Loom",
      baseUrl: (profile?.baseUrl ?? "http://127.0.0.1:8787").trim(),
      tenant: (profile?.tenant ?? "").trim(),
      authMode: profile?.authMode ?? "token",
      caPem: profile?.caPem?.trim() || undefined,
      oidcIssuer: profile?.oidcIssuer?.trim() || undefined,
      oidcClientId: profile?.oidcClientId?.trim() || undefined,
      oidcAudience: profile?.oidcAudience?.trim() || undefined,
      oidcScopes: profile?.oidcScopes?.trim() || undefined,
      crashReporting: profile?.crashReporting,
      crashEndpoint: profile?.crashEndpoint?.trim() || undefined,
    };
  }

  async function saveProfile(connectAfterSave = true): Promise<Profile | undefined> {
    const next = profileDraft();
    if (!next.tenant) {
      setError("Tenant is required.");
      return;
    }
    if (next.authMode === "oidc" && (!next.oidcIssuer || !next.oidcClientId)) {
      setError("OIDC issuer and client ID are required.");
      return;
    }
    if (tokenDraft) await saveToken(next.id, tokenDraft);
    setProfiles((current) => [...current.filter((item) => item.id !== next.id), next]);
    setProfileId(next.id);
    setTokenDraft("");
    if (connectAfterSave) await connect(next, tokenDraft || undefined);
    return next;
  }

  function updateProfile<K extends keyof Omit<Profile, "id">>(field: K, value: Profile[K]) {
    if (!profile) {
      const next: Profile = {
        id: crypto.randomUUID(), name: "Local Loom", baseUrl: "http://127.0.0.1:8787",
        tenant: "alice", authMode: "token", [field]: value,
      };
      setProfiles((current) => [...current, next]);
      setProfileId(next.id);
      return;
    }
    setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, [field]: value } : item));
  }

  async function signInWithOidc() {
    const next = await saveProfile(false);
    if (!next?.oidcIssuer || !next.oidcClientId) return;
    try {
      await configureProfileTransport(next.id, next.baseUrl, next.caPem);
      await beginOidcLogin({
        profileId: next.id,
        issuer: next.oidcIssuer,
        clientId: next.oidcClientId,
        audience: next.oidcAudience,
        scopes: next.oidcScopes,
        caPem: next.caPem,
      });
    } catch (nextError) {
      setError(formatError(nextError));
      void recordDiagnostic("auth").catch(() => undefined);
    }
  }

  async function inspectDiagnostics() {
    try { setDiagnostics(await loadDiagnosticReport()); }
    catch (nextError) { setError(formatError(nextError)); }
  }

  async function findUpdate(allowRollback = false) {
    setLoading(true);
    try {
      setUpdateInfo(await checkForUpdate(updateChannel, allowRollback));
      setRollbackInfo(await loadRollbackMetadata(updateChannel));
      void recordDiagnostic("update").catch(() => undefined);
    } catch (nextError) {
      setError(formatError(nextError));
      void recordDiagnostic("update").catch(() => undefined);
    } finally { setLoading(false); }
  }

  async function installUpdate() {
    setLoading(true);
    try {
      if (!await installPendingUpdate()) setError("No signed update is ready to install.");
    } catch (nextError) { setError(formatError(nextError)); }
    finally { setLoading(false); }
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

  const reportError = useCallback((nextError: unknown) => setError(formatError(nextError)), []);

  const ideUrl = workspace?.executor?.ideUrl;
  const previewUrl = workspace?.executor?.previewUrl;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div><strong>Loom</strong><span>Development workbench</span></div></div>
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
          <div className={status?.readiness.ok ? "health ok" : offlineAt ? "health cached" : "health"}><span/>{status ? (status.readiness.ok ? "Ready" : "Degraded") : offlineAt ? "Cached" : "Offline"}</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">{profile?.tenant ?? "No tenant"}</span><h1>{project || "Workspace"}</h1></div>
          <div className="topbar-actions">
            {previewUrl && <button className="secondary" onClick={() => void openExternal(previewUrl).catch(reportError)}><Eye size={16}/> Preview <ExternalLink size={13}/></button>}
            {ideUrl && <button className="secondary" onClick={() => void openExternal(ideUrl).catch(reportError)}><Code2 size={16}/> Open IDE <ExternalLink size={13}/></button>}
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
              {client && profile && <RunWorkbench client={client} profileId={profile.id} profileName={profile.name} tenant={profile.tenant} project={project} run={selected} events={events} clientId={CLIENT_ID} streamActive={!TERMINAL.has(selected.status)} onError={reportError}/>}
            </> : <div className="empty-detail"><ShieldCheck size={34}/><h2>Select a run</h2><p>Inspect the durable timeline, intervene, and decide human gates here.</p></div>}
          </section>
        </div>
      </main>

      {showSettings && <div className="modal-backdrop"><div className="modal settings-modal">
        <div className="modal-head"><div><span className="eyebrow">Secure connection</span><h2>{profile ? "Server profile" : "Add Loom server"}</h2></div><button className="icon-button" onClick={() => setShowSettings(false)}><X size={18}/></button></div>
        <div className="settings-scroll">
          <section className="settings-section">
            <h3>Connection</h3>
            <div className="field-grid">
              <label>Name<input value={profile?.name ?? "Local Loom"} onChange={(event) => updateProfile("name", event.target.value)}/></label>
              <label>Tenant<input value={profile?.tenant ?? "alice"} onChange={(event) => updateProfile("tenant", event.target.value)} spellCheck={false}/></label>
            </div>
            <label>Server URL<input value={profile?.baseUrl ?? "http://127.0.0.1:8787"} onChange={(event) => updateProfile("baseUrl", event.target.value)} spellCheck={false}/></label>
          </section>

          <section className="settings-section">
            <h3>Authentication</h3>
            <div className="segmented" aria-label="Authentication mode">
              <button className={(profile?.authMode ?? "token") === "token" ? "active" : ""} onClick={() => updateProfile("authMode", "token")}>API token</button>
              <button className={profile?.authMode === "oidc" ? "active" : ""} onClick={() => updateProfile("authMode", "oidc")}>OIDC</button>
            </div>
            {(profile?.authMode ?? "token") === "token" ? (
              <label>API token<input type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder={profile ? "Stored in OS keychain; leave blank to keep" : "Required"}/></label>
            ) : <>
              <label>Issuer URL<input value={profile?.oidcIssuer ?? ""} onChange={(event) => updateProfile("oidcIssuer", event.target.value)} spellCheck={false}/></label>
              <label>Client ID<input value={profile?.oidcClientId ?? ""} onChange={(event) => updateProfile("oidcClientId", event.target.value)} spellCheck={false}/></label>
              <div className="field-grid">
                <label>API audience<input value={profile?.oidcAudience ?? ""} onChange={(event) => updateProfile("oidcAudience", event.target.value)} spellCheck={false}/></label>
                <label>Scopes<input value={profile?.oidcScopes ?? "openid profile email"} onChange={(event) => updateProfile("oidcScopes", event.target.value)} spellCheck={false}/></label>
              </div>
            </>}
            <p className="security-note"><ShieldCheck size={15}/> Credentials are stored in the operating system keychain.</p>
          </section>

          <section className="settings-section">
            <h3>Enterprise trust</h3>
            <label>Custom CA certificate chain<textarea className="certificate-input" value={profile?.caPem ?? ""} onChange={(event) => updateProfile("caPem", event.target.value)} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----"/></label>
          </section>

          <section className="settings-section">
            <h3>Diagnostics</h3>
            <label className="check-row"><input type="checkbox" checked={profile?.crashReporting === true} onChange={(event) => updateProfile("crashReporting", event.target.checked)}/><span>Send pending crash reports</span></label>
            {profile?.crashReporting && <label>Report endpoint<input value={profile.crashEndpoint ?? ""} onChange={(event) => updateProfile("crashEndpoint", event.target.value)} spellCheck={false} placeholder="https://diagnostics.example.com/desktop"/></label>}
            <button className="secondary" onClick={() => void inspectDiagnostics()}><Bug size={15}/> Inspect local report</button>
            {diagnostics && <pre className="diagnostic-report">{JSON.stringify(diagnostics, null, 2)}</pre>}
          </section>

          <section className="settings-section">
            <h3>Updates</h3>
            <div className="segmented" aria-label="Update channel">
              <button className={updateChannel === "stable" ? "active" : ""} onClick={() => setUpdateChannel("stable")}>Stable</button>
              <button className={updateChannel === "beta" ? "active" : ""} onClick={() => setUpdateChannel("beta")}>Beta</button>
            </div>
            <div className="inline-actions">
              <button className="secondary" onClick={() => void findUpdate()}><RefreshCw size={15}/> Check</button>
              {rollbackInfo?.previousVersion && <button className="secondary" onClick={() => void findUpdate(true)}><Undo2 size={15}/> Roll back to {rollbackInfo.previousVersion}</button>}
              {updateInfo && <button className="primary" onClick={() => void installUpdate()}><Download size={15}/> Install {updateInfo.version}</button>}
            </div>
            {!updateInfo && rollbackInfo && <p className="security-note">Channel release: {rollbackInfo.currentVersion}</p>}
          </section>
        </div>
        <div className="modal-actions">{profile && <button className="danger-text" onClick={() => void removeProfile()}>Remove</button>}<span/><button className="secondary" onClick={() => setShowSettings(false)}>Cancel</button>{profile?.authMode === "oidc" ? <button className="primary" onClick={() => void signInWithOidc()}><LogIn size={16}/> Sign in</button> : <button className="primary" onClick={() => void saveProfile()}><Check size={16}/> Save & connect</button>}</div>
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

function RunActions({ run, onAction }: { run: RunSummary; onAction(action: "pause" | "cancel" | "resume" | "approve-review" | "reject-review" | "approve-deploy" | "reject-deploy"): void }) {
  if (run.status === "paused") return <button className="secondary" onClick={() => onAction("resume")}><RotateCcw size={15}/> Resume</button>;
  if (run.status === "review_required") return <div className="button-group"><button className="secondary" onClick={() => onAction("reject-review")}><X size={15}/> Reject</button><button className="primary" onClick={() => onAction("approve-review")}><Check size={15}/> Approve</button></div>;
  if (run.status === "deployment_required") return <div className="button-group"><button className="secondary" onClick={() => onAction("reject-deploy")}><X size={15}/> Reject</button><button className="primary" onClick={() => onAction("approve-deploy")}><ShieldCheck size={15}/> Deploy</button></div>;
  if (run.status === "running") return <div className="button-group"><button className="secondary" onClick={() => onAction("pause")}><Pause size={15}/> Pause</button><button className="secondary danger" onClick={() => onAction("cancel")}><CircleStop size={15}/> Cancel</button></div>;
  if (run.status === "queued") return <button className="secondary danger" onClick={() => onAction("cancel")}><CircleStop size={15}/> Cancel</button>;
  return null;
}
