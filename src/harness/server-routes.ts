export type HarnessServerRouteDomain = "runs" | "workspace" | "policy" | "vas" | "control-plane" | "operator";

export interface HarnessServerRouteCandidate {
  domain: HarnessServerRouteDomain;
  name: string;
  handle: () => Promise<boolean>;
}

export interface HarnessServerRouteMatch {
  domain: HarnessServerRouteDomain;
  name: string;
}

export async function dispatchHarnessServerRoutes(
  candidates: HarnessServerRouteCandidate[],
): Promise<HarnessServerRouteMatch | undefined> {
  for (const candidate of candidates) {
    if (await candidate.handle()) return { domain: candidate.domain, name: candidate.name };
  }
  return undefined;
}
