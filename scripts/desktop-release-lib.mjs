export function promotionVersion(channel, versionTag) {
  if (!["stable", "beta"].includes(channel)) {
    throw new Error("usage: promote-desktop-release.mjs <stable|beta> <desktop-channel-vVERSION>");
  }
  const match = new RegExp(`^desktop-${channel}-v(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)$`).exec(versionTag ?? "");
  if (!match) {
    throw new Error("usage: promote-desktop-release.mjs <stable|beta> <desktop-channel-vVERSION>");
  }
  return match[1];
}

export function validateUpdaterManifestStructure(value, expectedVersion) {
  if (
    !value
    || typeof value !== "object"
    || typeof value.version !== "string"
    || !value.platforms
    || typeof value.platforms !== "object"
    || Array.isArray(value.platforms)
    || (expectedVersion && value.version !== expectedVersion)
  ) {
    throw new Error("version release contains an invalid updater manifest");
  }
}

export function buildRollbackMetadata(channel, versionTag, next, previous, now = new Date()) {
  const expectedVersion = promotionVersion(channel, versionTag);
  validateUpdaterManifestStructure(next, expectedVersion);
  if (previous) validateUpdaterManifestStructure(previous);
  const hasPrevious = previous?.version !== undefined && previous.version !== next.version;
  return {
    schemaVersion: "loom-desktop-rollback/v1",
    channel,
    currentVersion: next.version,
    currentTag: versionTag,
    previousVersion: hasPrevious ? previous.version : undefined,
    previousTag: hasPrevious ? `desktop-${channel}-v${previous.version}` : undefined,
    publishedAt: now.toISOString(),
  };
}

export function staleRollbackAssets(existingAssets, rollback) {
  return !rollback.previousVersion && existingAssets.includes("rollback-latest.json")
    ? ["rollback-latest.json"]
    : [];
}

export function validateDesktopUpdaterManifest({
  manifest,
  expectedVersion,
  expectedTag,
  repository,
  includeLinux,
  assets,
}) {
  validateUpdaterManifestStructure(manifest, expectedVersion);
  const requiredTargets = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ];
  if (includeLinux) requiredTargets.push("linux-x86_64");
  const assetsById = new Map(assets.map((asset) => [String(asset.id), asset.name]));
  const assetNames = new Set(assets.map((asset) => asset.name));
  const tagPrefix = `/${repository}/releases/download/${expectedTag}/`;
  const apiPrefix = `/repos/${repository}/releases/assets/`;

  for (const target of requiredTargets) {
    const entry = manifest.platforms[target];
    if (!entry || typeof entry.signature !== "string" || !entry.signature.trim() || typeof entry.url !== "string") {
      throw new Error(`updater manifest is missing signed target ${target}`);
    }
    const url = new URL(entry.url);
    let asset;
    if (url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(tagPrefix)) {
      asset = decodeURIComponent(url.pathname.slice(tagPrefix.length));
    } else if (url.protocol === "https:" && url.hostname === "api.github.com" && url.pathname.startsWith(apiPrefix)) {
      asset = assetsById.get(url.pathname.slice(apiPrefix.length));
    } else {
      throw new Error(`updater target ${target} is not pinned to ${expectedTag}`);
    }
    if (!asset || asset.includes("/") || !assetNames.has(asset) || !assetNames.has(`${asset}.sig`)) {
      throw new Error(`updater target ${target} does not reference uploaded artifact and signature assets`);
    }
  }
}
