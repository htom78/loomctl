import { useCallback, useEffect, useRef, useState } from "react";
import { CircleStop, History, LoaderCircle, Play, RefreshCw, TerminalSquare } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { LoomClient, WorkspaceCommandSummary, WorkspaceRoute, WorkspaceSessionEvent, WorkspaceSessionSummary } from "@loom/api";
import "@xterm/xterm/css/xterm.css";
import { cacheKey, isOfflineError, metadataCache } from "./cache";

interface TerminalWorkbenchProps {
  client: LoomClient;
  route: WorkspaceRoute;
  clientId: string;
  profileId: string;
  setFocus(focus: string): void;
  onError(error: unknown): void;
}

export function TerminalWorkbench({ client, route, clientId, profileId, setFocus, onError }: TerminalWorkbenchProps) {
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [commands, setCommands] = useState<WorkspaceCommandSummary[]>([]);
  const [selected, setSelected] = useState<WorkspaceSessionSummary | null>(null);
  const [sessionCommand, setSessionCommand] = useState("sh");
  const [oneShotCommand, setOneShotCommand] = useState("");
  const [commandResult, setCommandResult] = useState<WorkspaceCommandSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const streamRef = useRef<AbortController | null>(null);
  const inputQueueRef = useRef(Promise.resolve());
  const scopeKey = `${route.project}:${route.runId ?? "project"}`;
  const sessionsCacheKey = cacheKey(profileId, route.tenant, `sessions:${scopeKey}`);
  const commandsCacheKey = cacheKey(profileId, route.tenant, `commands:${scopeKey}`);
  const hasRunningSession = sessions.some((session) => session.status === "running");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSessions, nextCommands] = await Promise.all([
        client.workspaceSessions(route),
        client.workspaceCommands(route),
      ]);
      setSessions(nextSessions);
      setCommands(nextCommands);
      metadataCache.set(sessionsCacheKey, nextSessions);
      metadataCache.set(commandsCacheKey, nextCommands);
      setOffline(false);
      setSelected((current) => current ? nextSessions.find((item) => item.sessionId === current.sessionId) ?? current : current);
    } catch (error) {
      const cachedSessions = metadataCache.get<WorkspaceSessionSummary[]>(sessionsCacheKey);
      const cachedCommands = metadataCache.get<WorkspaceCommandSummary[]>(commandsCacheKey);
      if ((cachedSessions || cachedCommands) && isOfflineError(error)) {
        setSessions(cachedSessions?.value ?? []);
        setCommands(cachedCommands?.value ?? []);
        setOffline(true);
      } else {
        onError(error);
      }
    } finally {
      setLoading(false);
    }
  }, [client, route.tenant, route.project, route.runId, sessionsCacheKey, commandsCacheKey, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: { background: "#111211", foreground: "#dce0d8", cursor: "#d5ff51", selectionBackground: "#526025" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !selected || selected.status !== "running" || offline) return;
    const disposable = terminal.onData((input) => {
      inputQueueRef.current = inputQueueRef.current
        .then(() => client.sendWorkspaceSessionInput(route, selected.sessionId, input, clientId))
        .then(() => undefined)
        .catch(onError);
    });
    return () => disposable.dispose();
  }, [client, route.tenant, route.project, route.runId, selected?.sessionId, selected?.status, clientId, offline, onError]);

  useEffect(() => () => streamRef.current?.abort(), []);

  async function openSession(session: WorkspaceSessionSummary) {
    streamRef.current?.abort();
    setSelected(session);
    setFocus(`session:${session.sessionId}`);
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    try {
      const events = await client.workspaceSessionEvents(route, session.sessionId);
      for (const event of events) writeSessionEvent(terminal, event);
      const after = events.reduce((max, event) => Math.max(max, event.seq), 0);
      if (session.status !== "running") return;
      const controller = new AbortController();
      streamRef.current = controller;
      void client.watchWorkspaceSession(route, session.sessionId, {
        after,
        signal: controller.signal,
        reconnect: true,
        onEvent(event) {
          writeSessionEvent(terminal, event);
          if (event.type === "exit") {
            controller.abort();
            void refresh();
          }
        },
      }).catch((error) => {
        if (!controller.signal.aborted) onError(error);
      });
    } catch (error) {
      onError(error);
    }
  }

  async function startSession() {
    setLoading(true);
    try {
      const session = await client.createWorkspaceSession(route, sessionCommand.trim() || "sh", clientId);
      await refresh();
      await openSession(session);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function stopSession() {
    if (!selected) return;
    try {
      await client.stopWorkspaceSession(route, selected.sessionId, clientId);
      streamRef.current?.abort();
      await refresh();
    } catch (error) {
      onError(error);
    }
  }

  async function runCommand() {
    if (!oneShotCommand.trim()) return;
    setLoading(true);
    try {
      const result = await client.runWorkspaceCommand(route, oneShotCommand.trim(), clientId);
      setCommandResult(result);
      setFocus(`command:${result.commandId}`);
      setOneShotCommand("");
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  return <div className="workbench-pane terminal-workbench">
    <div className="workbench-toolbar">
      <TerminalSquare size={15}/><strong>Terminal</strong>
      {offline && <span className="offline-badge">Cached metadata</span>}
      <span className="toolbar-spacer"/>
      <input value={sessionCommand} onChange={(event) => setSessionCommand(event.target.value)} aria-label="Session command" spellCheck={false}/>
      <button className="secondary compact-button" onClick={() => void startSession()} disabled={loading || offline || hasRunningSession} title={hasRunningSession ? "Stop the running session first" : undefined}><Play size={14}/> Start</button>
      <button className="icon-button compact-icon" title="Refresh history" onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""}/></button>
    </div>
    <div className="terminal-layout">
      <aside className="history-rail">
        <div className="subsection-title"><History size={13}/> Sessions</div>
        <div className="history-list">
          {sessions.map((session) => <button key={session.sessionId} className={selected?.sessionId === session.sessionId ? "history-row active" : "history-row"} onClick={() => void openSession(session)}>
            <span>{session.command}</span><small>{session.status} · {session.eventCount} events</small>
          </button>)}
          {!sessions.length && <div className="empty-small">No session history</div>}
        </div>
        <div className="subsection-title command-title"><History size={13}/> Commands</div>
        <div className="history-list command-history">
          {commands.map((command) => <button key={command.commandId} className="history-row" onClick={() => { setCommandResult(command); setFocus(`command:${command.commandId}`); }}>
            <span>{command.command}</span><small>exit {command.exitCode} · {new Date(command.endedAt).toLocaleTimeString()}</small>
          </button>)}
        </div>
      </aside>
      <div className="terminal-main">
        <div className="terminal-status">
          <span>{selected ? `${selected.command} · ${selected.status}` : "Select or start a session"}</span>
          {selected?.status === "running" && <button className="secondary danger compact-button" onClick={() => void stopSession()}><CircleStop size={14}/> Stop</button>}
        </div>
        <div ref={hostRef} className="xterm-host"/>
        <div className="command-runner">
          <input value={oneShotCommand} onChange={(event) => setOneShotCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runCommand(); }} placeholder="Run one-shot workspace command" spellCheck={false} disabled={hasRunningSession}/>
          <button className="secondary compact-button" disabled={!oneShotCommand.trim() || loading || offline || hasRunningSession} title={hasRunningSession ? "Stop the running session first" : undefined} onClick={() => void runCommand()}>{loading ? <LoaderCircle size={14} className="spin"/> : <Play size={14}/>} Run</button>
        </div>
        {commandResult && <pre className="command-result"><span>$ {commandResult.command}</span>{commandResult.stdout}{commandResult.stderr && `\n${commandResult.stderr}`}<small>exit {commandResult.exitCode}</small></pre>}
      </div>
    </div>
  </div>;
}

function writeSessionEvent(terminal: XTerm, event: WorkspaceSessionEvent): void {
  if (event.type === "start") terminal.writeln(`$ ${event.data ?? ""}`);
  else if (event.type === "stdout" || event.type === "stderr") terminal.write(event.data ?? "");
  else if (event.type === "input") terminal.writeln(`\r\n[input ${event.dataBytes ?? 0} bytes]`);
  else if (event.type === "stop") terminal.writeln("\r\n[stop requested]");
  else if (event.type === "exit") terminal.writeln(`\r\n[exit ${event.exitCode ?? "?"}${event.signal ? ` ${event.signal}` : ""}]`);
}
