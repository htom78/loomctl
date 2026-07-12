import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The harness serves ONE self-contained index.html (see ADR 0001), so inline
// everything and disable code-splitting — the singlefile plugin folds all JS and
// CSS into the HTML, matching the current no-external-asset CSP posture.
const HARNESS = process.env.LOOM_DEV_HARNESS ?? "http://127.0.0.1:8787";
const proxied = ["/status", "/metrics", "/runs", "/tenants", "/events", "/audit", "/workspace", "/workspace-usage"];

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
  // `npm run dev` proxies API calls to a locally running harness so the SPA works
  // against real data during development.
  server: {
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: HARNESS, changeOrigin: true }])),
  },
});
