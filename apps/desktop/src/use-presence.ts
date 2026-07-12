import { useCallback, useEffect, useState } from "react";
import type { LoomClient, PresenceEntry, WorkspaceRoute } from "@loom/api";

export function usePresence(client: LoomClient, route: WorkspaceRoute, clientId: string, label: string) {
  const [focus, setFocus] = useState(`run:${route.runId ?? route.project}`);
  const [entries, setEntries] = useState<PresenceEntry[]>([]);

  const refresh = useCallback(async () => {
    const next = await client.presence(route);
    setEntries(next);
  }, [client, route.tenant, route.project, route.runId]);

  const heartbeat = useCallback(async () => {
    await client.updatePresence(route, clientId, label, focus);
    await refresh();
  }, [client, route.tenant, route.project, route.runId, clientId, label, focus, refresh]);

  useEffect(() => {
    void heartbeat().catch(() => undefined);
    const timer = window.setInterval(() => void heartbeat().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [heartbeat]);

  return { entries, focus, setFocus, refresh };
}
