// Shared secret-scrubbing for any free-text value that becomes viewer-readable:
// tenant audit events, and run error messages/events (which surface through the
// run summary, replay, /events, and /events/stream endpoints). Secrets leak into
// free text when an upstream failure echoes a credentialed URL or bearer token;
// key-name filtering cannot catch them because the field name (e.g. "message",
// "error") is not itself sensitive. This does NOT redact by key name, so
// structured non-secret metadata (tokenEnvName, apiKeyId, modelKeyEnv — env var
// names, not secrets) is preserved.

const MAX_REDACT_STRING_LENGTH = 2000;

export function scrubSecretText(value: string): string {
  let scrubbed = value
    // URL userinfo: scheme://user:pass@host -> scheme://[redacted]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    // Authorization bearer tokens.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    // Inline secret assignments: token=..., secret: ..., api_key=..., etc.
    .replace(/\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)\b(\s*[=:]\s*)\S+/gi, "$1$2[redacted]");
  if (scrubbed.length > MAX_REDACT_STRING_LENGTH) {
    scrubbed = `${scrubbed.slice(0, MAX_REDACT_STRING_LENGTH - 3)}...`;
  }
  return scrubbed;
}

export function scrubSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted:depth]";
  if (typeof value === "string") return scrubSecretText(value);
  if (Array.isArray(value)) return value.map((entry) => scrubSecretsDeep(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecretsDeep(entry, depth + 1);
    }
    return out;
  }
  return value;
}
