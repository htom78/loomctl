import type { HarnessEvent } from "../../harness/events.js";

// Compact one-line rendering of a run event for a live terminal monitor
// (`loom run --watch`, and any future TUI). Kept defensive: event payloads vary
// by type, so read fields optionally and fall back to the bare type.
function truncate(value: unknown, max = 100): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatEvent(event: HarnessEvent): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const seq = String(event.seq ?? "").padStart(3, " ");
  switch (event.type) {
    case "user_message":
      return `${seq} goal        ${truncate(data.message ?? data.goal)}`;
    case "assistant_message":
      return `${seq} assistant   ${truncate(data.message)}`;
    case "action": {
      const tool = data.tool ?? data.name ?? "action";
      return `${seq} → ${String(tool).padEnd(10)}${truncate(data.command ?? data.args ?? data.path ?? "")}`;
    }
    case "observation":
      return `${seq}   observed  ${truncate(data.summary ?? data.output ?? (data.exitCode !== undefined ? `exit ${data.exitCode}` : ""))}`;
    case "verification":
      return `${seq} ${data.ok ? "✓" : "✗"} verify     ${truncate(data.output ?? (data.ok ? "passed" : "failed"))}`;
    case "evaluation":
      return `${seq} ${data.ok ? "✓" : "✗"} evaluate   ${truncate(data.output ?? "")}`;
    case "reviewer":
      return `${seq} · review    ${truncate(data.output ?? "")}`;
    case "finish":
      return `${seq} ■ finish    ${truncate(data.status ?? "")}`;
    case "error":
      return `${seq} ✗ error     ${truncate(data.message ?? "")}`;
    default:
      return `${seq} · ${String(event.type).padEnd(10)}${truncate(data)}`;
  }
}
