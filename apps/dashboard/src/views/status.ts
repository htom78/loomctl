import { apiGet } from "../lib/api.js";

// Renders the global operator /status view. The response shape is broad and
// still being ported faithfully (C4-D); for now surface the headline gauges when
// present and fall back to the raw payload so nothing is silently dropped.
interface StatusResponse {
  ready?: boolean;
  activeRuns?: number;
  queuedRuns?: number;
  tenants?: unknown[];
  [key: string]: unknown;
}

function stat(label: string, value: string, cls = ""): string {
  return `<div class="stat"><span class="label">${label}</span><span class="value ${cls}">${value}</span></div>`;
}

export async function renderStatus(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="card">Loading status…</div>`;
  try {
    const data = await apiGet<StatusResponse>("/status");
    const tenantCount = Array.isArray(data.tenants) ? data.tenants.length : "—";
    const cards = [
      stat("Ready", data.ready ? "UP" : "DOWN", data.ready ? "ok" : "bad"),
      stat("Active runs", String(data.activeRuns ?? "—")),
      stat("Queued runs", String(data.queuedRuns ?? "—")),
      stat("Tenants", String(tenantCount)),
    ].join("");
    root.innerHTML = `
      <div class="card"><div class="grid">${cards}</div></div>
      <div class="card">
        <div class="stat"><span class="label">Raw /status payload</span></div>
        <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      </div>`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    root.innerHTML = `<div class="card error">Failed to load /status: ${escapeHtml(message)}<br />
      If this is 401, append <code>?token=YOUR_OPERATOR_TOKEN</code> once to store it.</div>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
