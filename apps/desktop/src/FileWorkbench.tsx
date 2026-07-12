import { useCallback, useEffect, useMemo, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { AlertTriangle, ChevronRight, File, Folder, FolderOpen, GitCompare, Move, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { LoomApiError, type LoomClient, type PresenceEntry, type WorkspaceFileResponse, type WorkspaceRoute } from "@loom/api";
import { cacheKey, isOfflineError, metadataCache } from "./cache";

interface FileWorkbenchProps {
  client: LoomClient;
  route: WorkspaceRoute;
  clientId: string;
  profileId: string;
  presence: PresenceEntry[];
  setFocus(focus: string): void;
  onError(error: unknown): void;
}

interface FileConflict {
  remote?: Extract<WorkspaceFileResponse, { kind: "file" }>;
  activeEditors: PresenceEntry[];
  message: string;
  operation: "write" | "move" | "delete";
}

export function FileWorkbench({ client, route, clientId, profileId, presence, setFocus, onError }: FileWorkbenchProps) {
  const [scope, setScope] = useState<"run" | "project">("run");
  const [directory, setDirectory] = useState<Extract<WorkspaceFileResponse, { kind: "directory" }> | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [file, setFile] = useState<Extract<WorkspaceFileResponse, { kind: "file" }> | null>(null);
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"file" | "diff">("file");
  const [diff, setDiff] = useState("");
  const [newPath, setNewPath] = useState("");
  const [movePath, setMovePath] = useState("");
  const [conflict, setConflict] = useState<FileConflict | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const scopedRoute = useMemo<WorkspaceRoute>(() => scope === "run" ? route : { tenant: route.tenant, project: route.project }, [scope, route.tenant, route.project, route.runId]);
  const dirty = Boolean(file && content !== file.content);
  const sameFileEditors = file ? presence.filter((entry) => entry.clientId !== clientId && entry.focus === `file:${file.path}`) : [];

  const loadDirectory = useCallback(async (path = currentPath) => {
    setLoading(true);
    const requestedCacheKey = cacheKey(profileId, route.tenant, `files:${scope}:${route.project}:${route.runId ?? "project"}:${path}`);
    try {
      const value = await client.workspaceFiles(scopedRoute, path);
      if (value.kind !== "directory") throw new Error("Expected a workspace directory");
      setDirectory(value);
      setCurrentPath(value.path);
      metadataCache.set(cacheKey(profileId, route.tenant, `files:${scope}:${route.project}:${route.runId ?? "project"}:${value.path}`), value);
      setOffline(false);
      setFocus(value.path ? `dir:${value.path}` : `${scope}:${route.runId ?? route.project}`);
    } catch (error) {
      const cached = metadataCache.get<Extract<WorkspaceFileResponse, { kind: "directory" }>>(requestedCacheKey);
      if (cached && isOfflineError(error)) {
        setDirectory(cached.value);
        setOffline(true);
      } else {
        onError(error);
      }
    } finally {
      setLoading(false);
    }
  }, [client, scopedRoute.tenant, scopedRoute.project, scopedRoute.runId, currentPath, profileId, route.tenant, route.project, route.runId, scope, setFocus, onError]);

  useEffect(() => {
    setCurrentPath("");
    setFile(null);
    setConflict(null);
    setMode("file");
    void loadDirectory("");
  }, [scope, route.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openEntry(path: string, kind: "directory" | "file") {
    setConflict(null);
    if (kind === "directory") {
      setFile(null);
      await loadDirectory(path);
      return;
    }
    setLoading(true);
    try {
      const value = await client.workspaceFiles(scopedRoute, path);
      if (value.kind !== "file") throw new Error("Expected a workspace file");
      setFile(value);
      setContent(value.content);
      setMovePath(value.path);
      setMode("file");
      setOffline(false);
      setFocus(`file:${value.path}`);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function saveFile(force = false) {
    if (!file || offline) return;
    setLoading(true);
    try {
      const value = await client.writeWorkspaceFile(scopedRoute, file.path, content, force ? undefined : file.updatedAt, clientId);
      if (value.kind !== "file") throw new Error("Expected a saved workspace file");
      setFile(value);
      setContent(value.content);
      setConflict(null);
      await loadDirectory(parentPath(value.path));
    } catch (error) {
      await handleConflict(error, file.path, "write");
    } finally {
      setLoading(false);
    }
  }

  async function createFile() {
    const path = newPath.trim();
    if (!path || offline) return;
    setLoading(true);
    try {
      const value = await client.writeWorkspaceFile(scopedRoute, path, "", undefined, clientId);
      if (value.kind !== "file") throw new Error("Expected a new workspace file");
      setNewPath("");
      await loadDirectory(parentPath(path));
      await openEntry(path, "file");
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function moveFile(force = false) {
    if (!file || !movePath.trim() || movePath.trim() === file.path || offline) return;
    setLoading(true);
    try {
      const value = await client.moveWorkspaceFile(scopedRoute, file.path, movePath.trim(), force ? undefined : file.updatedAt, clientId);
      if (value.kind !== "file") throw new Error("Expected a moved workspace file");
      setFile(value);
      setContent(value.content);
      setMovePath(value.path);
      setConflict(null);
      await loadDirectory(parentPath(value.path));
    } catch (error) {
      await handleConflict(error, file.path, "move");
    } finally {
      setLoading(false);
    }
  }

  async function deleteFile(force = false) {
    if (!file || offline) return;
    setLoading(true);
    try {
      const previous = file.path;
      await client.deleteWorkspaceFile(scopedRoute, previous, force ? undefined : file.updatedAt, clientId);
      setFile(null);
      setContent("");
      setConflict(null);
      await loadDirectory(parentPath(previous));
    } catch (error) {
      await handleConflict(error, file.path, "delete");
    } finally {
      setLoading(false);
    }
  }

  async function loadDiff() {
    setLoading(true);
    try {
      const result = await client.workspaceDiff(scopedRoute);
      setDiff(result.stdout || result.stderr || "No workspace changes.");
      setMode("diff");
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function handleConflict(error: unknown, path: string, operation: FileConflict["operation"]) {
    const body = error instanceof LoomApiError && isRecord(error.body) ? error.body : {};
    if (!(error instanceof LoomApiError) || error.status !== 409 || body.error !== "workspace file changed since it was loaded.") {
      onError(error);
      return;
    }
    let remote: FileConflict["remote"];
    try {
      const value = await client.workspaceFiles(scopedRoute, path);
      if (value.kind === "file") remote = value;
    } catch {}
    const activeEditors = Array.isArray(body.activeEditors) ? body.activeEditors.filter(isPresenceEntry) : sameFileEditors;
    setConflict({ remote, activeEditors, message: error.message, operation });
  }

  function acceptRemote() {
    if (!conflict?.remote) return;
    setFile(conflict.remote);
    setContent(conflict.remote.content);
    setMovePath(conflict.remote.path);
    setConflict(null);
  }

  async function retryConflict() {
    if (conflict?.operation === "move") await moveFile(true);
    else if (conflict?.operation === "delete") await deleteFile(true);
    else await saveFile(true);
  }

  const pathSegments = currentPath ? currentPath.split("/") : [];
  const editorLanguage = languageForPath(file?.path ?? "");

  return <div className="workbench-pane file-workbench">
    <div className="workbench-toolbar">
      <FolderOpen size={15}/><strong>Workspace</strong>
      <div className="segmented compact-segmented">
        <button className={scope === "run" ? "active" : ""} onClick={() => setScope("run")}>Run</button>
        <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>Project</button>
      </div>
      {offline && <span className="offline-badge">Cached tree · read only</span>}
      <span className="toolbar-spacer"/>
      <button className={mode === "diff" ? "secondary compact-button active-command" : "secondary compact-button"} onClick={() => void loadDiff()}><GitCompare size={14}/> Diff</button>
      <button className="icon-button compact-icon" title="Refresh files" onClick={() => void loadDirectory()}><RefreshCw size={14} className={loading ? "spin" : ""}/></button>
    </div>
    <div className="file-layout">
      <aside className="file-tree">
        <div className="breadcrumbs">
          <button onClick={() => void loadDirectory("")}>root</button>
          {pathSegments.map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={11}/><button onClick={() => void loadDirectory(pathSegments.slice(0, index + 1).join("/"))}>{part}</button></span>)}
        </div>
        <div className="file-list">
          {currentPath && <button className="file-row" onClick={() => void loadDirectory(parentPath(currentPath))}><Folder size={14}/><span>..</span></button>}
          {directory?.entries.map((entry) => <button key={entry.path} className={file?.path === entry.path ? "file-row active" : "file-row"} onClick={() => void openEntry(entry.path, entry.kind)}>
            {entry.kind === "directory" ? <Folder size={14}/> : <File size={14}/>}<span>{entry.name}</span>{entry.size !== undefined && <small>{formatBytes(entry.size)}</small>}
          </button>)}
          {!directory?.entries.length && <div className="empty-small">Empty directory</div>}
        </div>
        <div className="new-file-row"><input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="path/to/new-file.ts" spellCheck={false}/><button title="Create file" disabled={!newPath.trim() || offline} onClick={() => void createFile()}><Plus size={14}/></button></div>
      </aside>
      <div className="editor-main">
        <div className="editor-alerts">
          {sameFileEditors.length > 0 && <div className="collaboration-warning"><AlertTriangle size={14}/><span>{sameFileEditors.map(displayPresence).join(", ")} also editing this file</span></div>}
          {conflict && <div className="conflict-banner"><AlertTriangle size={15}/><div><strong>Remote file changed</strong><span>{conflict.message}{conflict.activeEditors.length ? ` · ${conflict.activeEditors.map(displayPresence).join(", ")}` : ""}</span></div><button className="secondary compact-button" disabled={!conflict.remote} onClick={acceptRemote}>Load remote</button><button className="primary compact-button" onClick={() => void retryConflict()}>{conflict.operation === "move" ? "Move anyway" : conflict.operation === "delete" ? "Delete anyway" : "Keep mine"}</button></div>}
        </div>
        <div className="editor-header">
          <span>{mode === "diff" ? "Workspace diff" : file?.path ?? "Select a file"}</span>
          {mode === "file" && file && <>
            <span className={dirty ? "dirty-indicator active" : "dirty-indicator"}>{dirty ? "Modified" : "Saved"}</span>
            <input className="move-input" value={movePath} onChange={(event) => setMovePath(event.target.value)} aria-label="Move target path" spellCheck={false}/>
            <button className="icon-button compact-icon" title="Move file" disabled={movePath === file.path || !movePath.trim() || offline} onClick={() => void moveFile()}><Move size={14}/></button>
            <button className="icon-button compact-icon danger-icon" title="Delete file" disabled={offline} onClick={() => void deleteFile()}><Trash2 size={14}/></button>
            <button className="primary compact-button" disabled={!dirty || offline} onClick={() => void saveFile()}><Save size={14}/> Save</button>
          </>}
        </div>
        <div className="monaco-host">
          {mode === "diff" ? <Editor height="100%" language="diff" value={diff} theme="vs-dark" options={readOnlyEditorOptions}/>
            : conflict?.remote && file ? <DiffEditor height="100%" original={conflict.remote.content} modified={content} language={editorLanguage} theme="vs-dark" options={diffEditorOptions}/>
              : file ? <Editor height="100%" language={editorLanguage} value={content} onChange={(value) => setContent(value ?? "")} theme="vs-dark" options={editorOptions}/>
                : <div className="empty-detail"><File size={28}/><h2>No file selected</h2><p>Choose a bounded text file from the workspace tree.</p></div>}
        </div>
      </div>
    </div>
  </div>;
}

const editorOptions = { automaticLayout: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, padding: { top: 12 }, scrollBeyondLastLine: false, wordWrap: "on" as const };
const readOnlyEditorOptions = { ...editorOptions, readOnly: true };
const diffEditorOptions = { ...editorOptions, readOnly: true, renderSideBySide: true };

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", yml: "yaml", yaml: "yaml", rs: "rust", py: "python", sh: "shell" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function displayPresence(entry: PresenceEntry): string {
  return entry.label || entry.actor || entry.clientId;
}

function isPresenceEntry(value: unknown): value is PresenceEntry {
  return isRecord(value) && typeof value.clientId === "string" && typeof value.label === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
