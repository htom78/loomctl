import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

interface NativeHttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

interface NativeHttpHead {
  status: number;
  headers: Array<[string, string]>;
}

type NativeStreamEvent =
  | { event: "chunk"; data: string }
  | { event: "end" }
  | { event: "error"; message: string };

export interface OidcLoginRequest {
  profileId: string;
  issuer: string;
  clientId: string;
  audience?: string;
  scopes?: string;
  caPem?: string;
}

export interface OidcLoginResult {
  profileId: string;
  actor: string;
}

export interface DesktopDiagnosticReport {
  schemaVersion: string;
  appVersion: string;
  os: string;
  architecture: string;
  events: Array<{ atUnixMs: number; category: string; status?: number }>;
  pendingCrash?: Record<string, unknown>;
}

export interface DesktopUpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  publishedAt?: string;
  channel: "stable" | "beta";
  rollback: boolean;
}

export interface RollbackMetadata {
  schemaVersion: "loom-desktop-rollback/v1";
  channel: "stable" | "beta";
  currentVersion: string;
  currentTag: string;
  previousVersion?: string;
  previousTag?: string;
  publishedAt: string;
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function configureProfileTransport(profileId: string, baseUrl: string, caPem?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("configure_http_profile", { profileId, baseUrl, caPem });
}

export function profileFetch(profileId: string): typeof globalThis.fetch {
  if (!isTauri()) return globalThis.fetch.bind(globalThis);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const requestId = crypto.randomUUID();
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const nativeRequest = {
      profileId,
      requestId,
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      body,
    };
    if (request.signal.aborted) throw abortError();
    const isStream = request.headers.get("accept") === "text/event-stream" || new URL(request.url).pathname.endsWith("/stream");
    if (!isStream) {
      const onAbort = () => undefined;
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await invoke<NativeHttpResponse>("http_request", { request: nativeRequest });
        if (request.signal.aborted) throw abortError();
        return new Response(response.status === 204 ? null : response.body, { status: response.status, headers: response.headers });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    }
    return streamResponse(nativeRequest, request.signal);
  };
}

async function streamResponse(nativeRequest: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const requestId = String(nativeRequest.requestId);
  const channel = new Channel<NativeStreamEvent>();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { ended = true; return invoke("cancel_http_stream", { requestId }); },
  });
  channel.onmessage = (event) => {
    if (ended || !streamController) return;
    if (event.event === "chunk") streamController.enqueue(decodeBase64(event.data));
    else if (event.event === "end") { ended = true; streamController.close(); }
    else { ended = true; streamController.error(new Error(event.message)); }
  };
  const onAbort = () => {
    if (ended) return;
    ended = true;
    void invoke("cancel_http_stream", { requestId });
    streamController?.error(abortError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const head = await invoke<NativeHttpHead>("start_http_stream", { request: nativeRequest, onEvent: channel });
    if (signal.aborted) throw abortError();
    return new Response(stream, { status: head.status, headers: head.headers });
  } catch (error) {
    ended = true;
    streamController?.error(error);
    throw error;
  } finally {
    if (ended) signal.removeEventListener("abort", onAbort);
  }
}

export async function beginOidcLogin(request: OidcLoginRequest): Promise<void> {
  if (!isTauri()) throw new Error("OIDC system-browser login requires Loom Desktop");
  const value = await invoke<{ authorizationUrl: string }>("start_oidc_login", { request });
  await openExternal(value.authorizationUrl);
}

export async function listenForOidcCallback(onResult: (result: OidcLoginResult) => void, onError: (error: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const handle = (urls: string[]) => {
    for (const callbackUrl of urls) {
      void invoke<OidcLoginResult>("complete_oidc_login", { callbackUrl }).then(onResult).catch(onError);
    }
  };
  const current = await getCurrent();
  if (current?.length) handle(current);
  return onOpenUrl(handle);
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  let granted = await isPermissionGranted();
  if (!granted) granted = await requestPermission() === "granted";
  if (granted) sendNotification({ title, body });
}

export async function recordDiagnostic(category: "auth" | "network" | "update" | "ui", status?: number): Promise<void> {
  if (isTauri()) await invoke("record_diagnostic", { input: { category, status } });
}

export async function loadDiagnosticReport(): Promise<DesktopDiagnosticReport | null> {
  return isTauri() ? invoke<DesktopDiagnosticReport>("diagnostic_report") : null;
}

export async function submitPendingCrash(enabled: boolean, endpoint: string, caPem?: string): Promise<boolean> {
  return isTauri() ? invoke<boolean>("submit_pending_crash", { enabled, endpoint, caPem }) : false;
}

export async function checkForUpdate(channel: "stable" | "beta", allowRollback = false): Promise<DesktopUpdateInfo | null> {
  return isTauri() ? invoke<DesktopUpdateInfo | null>("check_update", { channel, allowRollback }) : null;
}

export async function installPendingUpdate(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("install_update") : false;
}

export async function loadRollbackMetadata(channel: "stable" | "beta"): Promise<RollbackMetadata | null> {
  return isTauri() ? invoke<RollbackMetadata>("rollback_metadata", { channel }).catch(() => null) : null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
