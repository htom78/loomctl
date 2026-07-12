// Minimal API layer for the extracted dashboard. The operator token gates the
// cross-tenant /status and /metrics views; it is read from localStorage so it is
// never baked into the served HTML. Set it once via ?token=... or setToken().
const TOKEN_KEY = "loom_operator_token";

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("token");
  if (fromQuery) {
    setToken(fromQuery);
    // Drop the token from the visible URL once captured.
    history.replaceState(null, "", location.pathname + location.hash);
    return fromQuery;
  }
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
