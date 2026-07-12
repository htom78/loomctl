import { lazy, Suspense, useMemo, useState } from "react";
import { Activity, AlertCircle, Brain, Check, FileCode2, LoaderCircle, MessageSquare, Pause, Send, TerminalSquare, Users } from "lucide-react";
import type { HarnessEvent, LoomClient, RunSummary, WorkspaceRoute } from "@loom/api";
import { usePresence } from "./use-presence";

const FileWorkbench = lazy(() => import("./FileWorkbench").then((module) => ({ default: module.FileWorkbench })));
const TerminalWorkbench = lazy(() => import("./TerminalWorkbench").then((module) => ({ default: module.TerminalWorkbench })));
const InsightsWorkbench = lazy(() => import("./InsightsWorkbench").then((module) => ({ default: module.InsightsWorkbench })));

type WorkbenchView = "activity" | "files" | "terminal" | "insights";

interface RunWorkbenchProps {
  client: LoomClient;
  profileId: string;
  profileName: string;
  tenant: string;
  project: string;
  run: RunSummary;
  events: HarnessEvent[];
  clientId: string;
  streamActive: boolean;
  onError(error: unknown): void;
}

export function RunWorkbench({ client, profileId, profileName, tenant, project, run, events, clientId, streamActive, onError }: RunWorkbenchProps) {
  const [view, setView] = useState<WorkbenchView>("activity");
  const [comment, setComment] = useState("");
  const route = useMemo<WorkspaceRoute>(() => ({ tenant, project, runId: run.runId }), [tenant, project, run.runId]);
  const { entries: presence, setFocus } = usePresence(client, route, clientId, profileName || clientId);

  async function sendComment() {
    if (!comment.trim()) return;
    try {
      await client.comment(tenant, project, run.runId, comment.trim(), clientId);
      setComment("");
    } catch (error) {
      onError(error);
    }
  }

  function selectView(next: WorkbenchView) {
    setView(next);
    setFocus(`${next}:${run.runId}`);
  }

  return <div className="run-workbench">
    <div className="workbench-tabs">
      <Tab active={view === "activity"} onClick={() => selectView("activity")} icon={<Activity size={14}/>} label="Activity"/>
      <Tab active={view === "files"} onClick={() => selectView("files")} icon={<FileCode2 size={14}/>} label="Files"/>
      <Tab active={view === "terminal"} onClick={() => selectView("terminal")} icon={<TerminalSquare size={14}/>} label="Terminal"/>
      <Tab active={view === "insights"} onClick={() => selectView("insights")} icon={<Brain size={14}/>} label="VAS & Brain"/>
      <span className="toolbar-spacer"/>
      <div className="presence-summary" title={presence.map((entry) => `${entry.label}: ${entry.focus ?? "online"}`).join("\n")}><Users size={14}/><span>{presence.length}</span>{presence.slice(0, 3).map((entry) => <i key={entry.clientId}>{initials(entry.label)}</i>)}</div>
    </div>
    <div className="workbench-content">
      {view === "activity" && <ActivityView events={events} streamActive={streamActive}/>}
      <Suspense fallback={<div className="empty-state"><LoaderCircle size={22} className="spin"/><span>Loading workbench</span></div>}>
        {view === "files" && <FileWorkbench client={client} route={route} clientId={clientId} profileId={profileId} presence={presence} setFocus={setFocus} onError={onError}/>}
        {view === "terminal" && <TerminalWorkbench client={client} route={route} clientId={clientId} profileId={profileId} setFocus={setFocus} onError={onError}/>}
        {view === "insights" && <InsightsWorkbench client={client} tenant={tenant} project={project} run={run} clientId={clientId} profileId={profileId} setFocus={setFocus} onError={onError}/>}
      </Suspense>
    </div>
    {view === "activity" && <div className="comment-box"><MessageSquare size={17}/><input value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void sendComment(); }} placeholder="Steer this run or leave review context"/><button title="Send comment" onClick={() => void sendComment()} disabled={!comment.trim()}><Send size={16}/></button></div>}
  </div>;
}

function Tab({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return <button className={active ? "workbench-tab active" : "workbench-tab"} onClick={onClick} aria-label={label} title={label}>{icon}<span>{label}</span></button>;
}

function ActivityView({ events, streamActive }: { events: HarnessEvent[]; streamActive: boolean }) {
  return <div className="timeline" aria-live="polite">
    {events.map((event) => <EventRow key={event.seq} event={event}/>) }
    {!events.length && <div className="empty-state"><LoaderCircle size={22} className={streamActive ? "spin" : ""}/><span>{streamActive ? "Waiting for events" : "No event details loaded"}</span></div>}
  </div>;
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

function initials(label: string): string {
  return label.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}
