import "./styles/tokens.css";
import { renderStatus } from "./views/status.js";

// Hash-routed shell. Views are registered here and ported one at a time from the
// legacy DASHBOARD_HTML (see ADR 0001); only /status is live so far.
type View = (root: HTMLElement) => void | Promise<void>;

const routes: Record<string, { label: string; render: View }> = {
  status: { label: "Status", render: renderStatus },
};

function currentRoute(): string {
  const key = location.hash.replace(/^#\/?/, "") || "status";
  return routes[key] ? key : "status";
}

function renderShell(): { view: HTMLElement } {
  const active = currentRoute();
  const nav = Object.entries(routes)
    .map(([key, { label }]) => `<a href="#/${key}" class="${key === active ? "active" : ""}">${label}</a>`)
    .join("");
  document.body.innerHTML = `
    <header>
      <h1>Loom Harness</h1>
      <nav>${nav}</nav>
    </header>
    <main id="view"></main>`;
  return { view: document.getElementById("view") as HTMLElement };
}

async function route(): Promise<void> {
  const { view } = renderShell();
  await routes[currentRoute()].render(view);
}

window.addEventListener("hashchange", () => void route());
void route();
