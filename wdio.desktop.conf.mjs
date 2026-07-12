import { resolve } from "node:path";

const application = resolve(process.env.LOOM_DESKTOP_E2E_BINARY ?? "apps/desktop/src-tauri/target/release/loom-desktop");
const driverProvider = process.env.LOOM_DESKTOP_E2E_DRIVER ?? "external";
const spec = process.env.LOOM_DESKTOP_E2E_SPEC ?? "./tests/desktop-installed.e2e.mjs";

export const config = {
  runner: "local",
  specs: [spec],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application },
  }],
  services: [["@wdio/tauri-service", {
    appBinaryPath: application,
    driverProvider,
    autoInstallTauriDriver: false,
    captureBackendLogs: true,
    captureFrontendLogs: true,
    startTimeout: 60_000,
  }]],
  framework: "jasmine",
  reporters: ["spec"],
  outputDir: ".codex-tmp/wdio",
  logLevel: "info",
  waitforTimeout: 15_000,
  connectionRetryTimeout: Number(process.env.LOOM_DESKTOP_E2E_CONNECTION_RETRY_TIMEOUT_MS ?? 90_000),
  connectionRetryCount: Number(process.env.LOOM_DESKTOP_E2E_CONNECTION_RETRY_COUNT ?? 2),
  jasmineOpts: { defaultTimeoutInterval: Number(process.env.LOOM_DESKTOP_E2E_TIMEOUT_MS ?? 120_000) },
};
