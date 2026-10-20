import { renderActivity } from "./activity.js";
import { createCanvasView, mergeActivityHistory } from "./canvas.js";
import { isTerminal, prettyStatus, toneFor } from "./state-view.js";

const nodes = {
  loopId: document.querySelector("#loopId"),
  iterCurrent: document.querySelector("#iterCurrent"),
  iterTotal: document.querySelector("#iterTotal"),
  statusPill: document.querySelector("#statusPill"),
  status: document.querySelector("#status"),
  warnings: document.querySelector("#warnings"),
  stop: document.querySelector("#stop"),
  activityCard: document.querySelector("#activityCard"),
  activity: document.querySelector("#activity"),
  canvasCard: document.querySelector("#canvasCard"),
  canvas: document.querySelector("#graphCanvas"),
  reset: document.querySelector("#canvasReset"),
  tooltip: document.querySelector("#canvasTooltip"),
  graphTable: document.querySelector("#graphTable"),
  activityTab: document.querySelector("#activityTab"),
  canvasTab: document.querySelector("#canvasTab"),
};

const app = {
  state: {},
  graph: undefined,
  activity: [],
  view: readStoredView(),
  polling: false,
};

const POLL_INTERVAL_MS = 3000;

const canvasView = nodes.canvas ? createCanvasView(nodes) : undefined;

function readStoredView() {
  try {
    const value = localStorage.getItem("preview.view");
    return value === "activity" ? "activity" : "canvas";
  } catch {
    return "canvas";
  }
}

function storeView(view) {
  try {
    localStorage.setItem("preview.view", view);
  } catch {
    // Local storage may be unavailable in tests or locked-down browsers.
  }
}

function setView(view) {
  app.view = view;
  storeView(view);
  nodes.activityTab?.setAttribute?.("aria-selected", view === "activity" ? "true" : "false");
  nodes.canvasTab?.setAttribute?.("aria-selected", view === "canvas" ? "true" : "false");
  nodes.activityCard.hidden = view !== "activity" || nodes.activity.children.length === 0;
  nodes.canvasCard.hidden = view !== "canvas";
  if (view === "canvas") {
    canvasView?.resize();
    canvasView?.render();
  }
}

function updateGraphTable() {
  if (!nodes.graphTable || !canvasView) return;
  const rows = [...canvasView.state.model.nodes.values()]
    .filter((node) => node.kind !== "branch")
    .map((node) => {
      const row = document.createElement("tr");
      const tip = tooltipForNodeFromCanvas(node);
      row.tabIndex = 0;
      row.dataset.nodeId = node.id;
      row.setAttribute?.("aria-label", [tip.title, ...tip.lines].join(". "));
      row.addEventListener?.("click", () => canvasView.centerNode(node.id));
      row.addEventListener?.("focus", () => canvasView.centerNode(node.id));
      for (const text of [node.iter, node.kind, node.status, node.meta.summary ?? node.meta.title ?? node.id]) {
        const cell = document.createElement("td");
        cell.textContent = String(text);
        row.append(cell);
      }
      return row;
    });
  nodes.graphTable.replaceChildren(...rows);
}

function tooltipForNodeFromCanvas(node) {
  const model = node.meta.model ? `${node.meta.model.provider}:${node.meta.model.model}${node.meta.model.effort ? `:${node.meta.model.effort}` : ""}` : "-";
  return {
    title: node.meta.title ?? node.id,
    lines: [`Status: ${node.status}`, `Iteration: ${node.iter}`, `Model: ${model}`],
  };
}

function render(state = app.state) {
  app.state = state;
  const iter = state.iter ?? 0;
  const max = state.maxIter ?? 0;
  const terminal = isTerminal(state.status);
  nodes.loopId.textContent = state.loopId || "-";
  nodes.iterCurrent.textContent = iter;
  nodes.iterTotal.textContent = max || "-";

  const tone = toneFor(state.status);
  nodes.statusPill.dataset.tone = tone;
  nodes.status.textContent = prettyStatus(state.status);
  nodes.warnings.textContent = (state.warnings || []).join("\n");

  app.activity = mergeActivityHistory(app.activity, state.activity ?? []);
  renderActivity(nodes, state, app.activity);
  canvasView?.update(state, app.graph, app.activity);
  updateGraphTable();
  setView(app.view);

  nodes.stop.disabled = terminal || state.status === "cancelling";
  nodes.stop.hidden = terminal;
}

async function loadState() {
  try {
    const response = await fetch("./state");
    render(await response.json());
  } catch {
    // Ignore transient failure; the next polling interval will recover.
  }
}

async function loadActivity() {
  try {
    const response = await fetch("./activity");
    const payload = await response.json();
    app.activity = payload.activity ?? [];
    render(app.state);
  } catch {
    // Older status servers may not expose /activity; state tail is enough.
  }
}

async function loadGraph() {
  try {
    const response = await fetch("./graph");
    app.graph = await response.json();
    canvasView?.update(app.state, app.graph, app.activity);
    updateGraphTable();
  } catch {
    // The Activity view remains useful if graph data is unavailable.
  }
}

async function poll() {
  if (app.polling) return;
  app.polling = true;
  try {
    await Promise.all([loadState(), loadActivity(), loadGraph()]);
  } finally {
    app.polling = false;
  }
}

nodes.stop.addEventListener("click", async () => {
  nodes.stop.disabled = true;
  nodes.stop.textContent = "Stopping...";
  await fetch("./stop", { method: "POST" });
  await loadState();
});

nodes.activityTab?.addEventListener("click", () => setView("activity"));
nodes.canvasTab?.addEventListener("click", () => setView("canvas"));
for (const tab of [nodes.canvasTab, nodes.activityTab]) {
  tab?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = app.view === "activity" ? nodes.canvasTab : nodes.activityTab;
    next?.focus();
    setView(app.view === "activity" ? "canvas" : "activity");
  });
}

await poll();
setInterval(poll, POLL_INTERVAL_MS);
