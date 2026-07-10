import { agentGitServiceControlPlaneProvider } from "./agent-git-service.js";
import {
  CONTROL_PLANE_PROVIDER_NAMES,
  type ControlPlaneProvider,
  type ControlPlaneProviderCatalogName,
} from "./control-plane.js";
import { giteaControlPlaneProvider } from "./gitea.js";

export const CONTROL_PLANE_PROVIDER_ADAPTERS = {
  "gitea-forgejo": giteaControlPlaneProvider,
  "agent-git-service": agentGitServiceControlPlaneProvider,
} as const satisfies Record<ControlPlaneProviderCatalogName, ControlPlaneProvider>;

export function controlPlaneProviderAdapter(name: string): ControlPlaneProvider | undefined {
  return isControlPlaneProviderCatalogName(name) ? CONTROL_PLANE_PROVIDER_ADAPTERS[name] : undefined;
}

function isControlPlaneProviderCatalogName(name: string): name is ControlPlaneProviderCatalogName {
  return (CONTROL_PLANE_PROVIDER_NAMES as readonly string[]).includes(name);
}
