import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./workbench.css";

async function bootstrap(): Promise<void> {
  if (import.meta.env.VITE_LOOM_E2E === "1") await import("@wdio/tauri-plugin");
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
