import { isTerminal } from "./state-view.js";

const TERMINAL_ISSUES = new Set(["resolved", "non-blocking", "blocking", "cancelled", "failed"]);
const RUNNING_ISSUES = new Set(["analyzing", "synthesizing"]);
const ITER_COLORS = ["#ff6b1a", "#ffa264", "#c2541a", "#ffd1a8", "#8a3a13", "#ffbe85"];
const WORKER_TO_REVIEWER_DX = 130;
const NEXT_ITER_GAP = 130;
const LANE_W = 118;
const REVIEWER_STACK_DY = 44;
const ANALYSIS_Y = 120;
const ANALYSIS_DY = 44;

function iterColor(iter) {
  return ITER_COLORS[Math.max(0, iter - 1) % ITER_COLORS.length];
}

function iterWidth() {
  return WORKER_TO_REVIEWER_DX + NEXT_ITER_GAP;
}

function iterBaseX(iter) {
  return iter * iterWidth();
}

function observerX(iter) {
  return iterBaseX(iter) + WORKER_TO_REVIEWER_DX;
}

function observerY(index, observerCount = 1) {
  return (index - (Math.max(1, observerCount) - 1) / 2) * REVIEWER_STACK_DY;
}

function expectedSpecs(graph) {
  return [
    { specId: "worker-0", role: "worker", model: graph?.worker, modelIndex: 0 },
    ...(graph?.observers ?? []).map((model, index) => ({ specId: `reviewer-${index}`, role: "reviewer", model, modelIndex: index })),
  ];
}

function statusFromActivity(entry) {
  if (!entry) return "idle";
  if (entry.status === "failed") return "failed";
  if (entry.status === "running") return "running";
  return "done";
}

function issueStatus(state) {
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "blocking") return "blocking";
  if (state === "non-blocking") return "non-blocking";
  if (RUNNING_ISSUES.has(state)) return "running";
  return "done";
}

function analysisStatus(issue, analysis) {
  if (analysis?.status === "failed") return "failed";
  if (analysis?.status === "completed") return "done";
  if (RUNNING_ISSUES.has(issue.state)) return "running";
  if (issue.state === "cancelled") return "cancelled";
  if (issue.state === "failed") return "failed";
  return "idle";
}

function activityKey(entry) {
  return `${entry.iter}|${entry.stage}|${entry.observerId ?? ""}|${entry.issueId ?? ""}|${entry.analysisName ?? ""}|${entry.title ?? ""}`;
}

export function mergeActivityHistory(history, tail) {
  const merged = new Map();
  for (const entry of [...history, ...(tail ?? [])]) {
    merged.set(activityKey(entry), entry);
  }
  return [...merged.values()].sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
}

function maxIterFromInputs(state, graph, activity) {
  const activityMax = activity.reduce((max, entry) => Math.max(max, Number(entry.iter) || 0), 0);
  const issueMax = (graph?.issues ?? []).reduce((max, issue) => Math.max(max, Number(issue.raisedInIter) || 0), 0);
  return Math.max(1, Number(state.maxIter) || 0, Number(state.iter) || 0, activityMax, issueMax);
}

function latestBy(activity, predicate) {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    if (predicate(activity[index])) return activity[index];
  }
  return undefined;
}

function observerActivity(activity, iter, index) {
  const entries = activity.filter((entry) => entry.iter === iter && entry.stage === "observer");
  return entries[index];
}

function node(id, kind, iter, column, status, meta = {}) {
  return { id, kind, iter, column, status, iterColor: iterColor(iter), meta };
}

function addEdge(edges, from, to, kind) {
  edges.push({ from, to, kind });
}

function addUniqueEdge(edges, seen, from, to, kind) {
  const key = `${from}->${to}:${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  addEdge(edges, from, to, kind);
}

export function buildGraphModel(state = {}, graph = { issues: [], observers: [] }, activity = []) {
  const nodes = new Map();
  const edges = [];
  const maxIter = maxIterFromInputs(state, graph, activity);
  const observerCount = Math.max(1, graph.observers?.length ?? 0);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const workerEntry = latestBy(activity, (entry) => entry.iter === iter && (entry.stage === "worker-work" || entry.stage === "worker-log"));
    let workerStatus = statusFromActivity(workerEntry);
    if (!isTerminal(state.status) && state.iter === iter && (state.currentActor === "worker.turn1" || state.currentActor === "worker.turn2")) {
      workerStatus = "running";
    }
    if (state.status === "cancelling" && state.iter === iter) workerStatus = "cancelled";
    nodes.set(`iter-${iter}.worker`, node(`iter-${iter}.worker`, "worker", iter, 0, workerStatus, {
      title: `Iteration ${iter} worker`,
      model: graph.worker,
      file: workerEntry?.file,
      summary: workerEntry?.summary,
    }));
    for (let index = 0; index < observerCount; index += 1) {
      const entry = observerActivity(activity, iter, index);
      let status = statusFromActivity(entry);
      if (!isTerminal(state.status) && state.iter === iter && state.currentActor === "observers") {
        status = "running";
      }
      const id = `iter-${iter}.observer-${index}`;
      nodes.set(id, node(id, "observer", iter, 0, status, {
        title: index === 0 ? `Iteration ${iter} reviewer` : `Iteration ${iter} reviewer ${index + 1}`,
        model: graph.observers?.[index],
        file: entry?.file,
        verdict: entry?.verdict,
        summary: entry?.summary,
      }));
      addEdge(edges, `iter-${iter}.worker`, id, "review");
      if (iter < maxIter) addEdge(edges, id, `iter-${iter + 1}.worker`, "trunk");
    }
  }

  const issues = [...(graph.issues ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const lanesByIter = new Map();
  for (const issue of issues) {
    const count = lanesByIter.get(issue.raisedInIter) ?? 0;
    lanesByIter.set(issue.raisedInIter, count + 1);
    const lane = count + 1;
    const validOrigin = Number.isInteger(issue.originObserverIndex)
      && issue.originObserverIndex >= 0
      && issue.originObserverIndex < observerCount;
    const originIndex = validOrigin ? issue.originObserverIndex : 0;
    nodes.set(`branch:${issue.id}`, node(`branch:${issue.id}`, "branch", issue.raisedInIter, lane, issueStatus(issue.state), {
      title: issue.source === "deadlock-detector" ? "Deadlock detector" : "Dispute branch",
      issueId: issue.id,
      flag: issue.flag,
      originObserverIndex: originIndex,
      deadlockAnchor: issue.source === "deadlock-detector",
      file: issue.files?.issue,
    }));
    const completed = new Map((issue.analysisNodes ?? []).map((analysis) => [analysis.specId, analysis]));
    const specs = expectedSpecs(graph);
    const shouldShowPlaceholders = RUNNING_ISSUES.has(issue.state);
    const allSpecs = shouldShowPlaceholders ? specs : (issue.analysisNodes ?? []).map((analysis) => ({
      specId: analysis.specId,
      role: analysis.role,
      model: analysis.model,
      modelIndex: analysis.modelIndex,
    }));
    for (const spec of allSpecs) {
      const analysis = completed.get(spec.specId);
      const id = `branch:${issue.id}:analysis:${spec.specId}`;
      nodes.set(id, node(id, "analysis", issue.raisedInIter, lane, analysisStatus(issue, analysis), {
        title: analysis?.name ?? `${spec.role ?? "analysis"} ${spec.modelIndex ?? ""}`.trim(),
        issueId: issue.id,
        flag: issue.flag,
        role: analysis?.role ?? spec.role,
        model: analysis?.model ?? spec.model,
        modelIndex: analysis?.modelIndex ?? spec.modelIndex,
        file: analysis?.file,
      }));
    }

    const synthesisId = issue.files?.synthesis
      ? `branch:${issue.id}:synthesis`
      : issue.state === "failed"
        ? `branch:${issue.id}:failed-merge`
        : issue.state === "synthesizing"
          ? `branch:${issue.id}:synthesis`
          : undefined;
    if (synthesisId) {
      const status = synthesisId.endsWith("failed-merge") ? "failed" : issueStatus(issue.state);
      nodes.set(synthesisId, node(synthesisId, "synthesis", issue.raisedInIter, lane, status, {
        title: synthesisId.endsWith("failed-merge") ? "Analysis failed" : "Synthesis",
        issueId: issue.id,
        flag: issue.flag,
        file: issue.files?.synthesis,
        summary: synthesisId.endsWith("failed-merge")
          ? "All analysis agents failed; no synthesis file was produced."
          : issue.synthesis?.reason,
      }));
      const anchorId = issue.source === "deadlock-detector" ? `branch:${issue.id}` : `iter-${issue.raisedInIter}.observer-${originIndex}`;
      addEdge(edges, synthesisId, anchorId, "resolutionArc");
      if (issue.raisedInIter + 1 <= maxIter) {
        addEdge(edges, synthesisId, `iter-${issue.raisedInIter + 1}.observer-0`, "forwardFeed");
      }
    }
  }

  const topologyEdges = new Set();
  for (const edge of graph.branchGraph?.edges ?? []) {
    const kind = edge.kind === "spawns" ? "spawnFan" : edge.kind === "feeds" ? "feedFan" : undefined;
    if (kind && nodes.has(edge.from) && nodes.has(edge.to)) {
      addUniqueEdge(edges, topologyEdges, edge.from, edge.to, kind);
    }
  }
  for (const issue of issues) {
    const branchId = `branch:${issue.id}`;
    const synthesisId = issue.files?.synthesis
      ? `branch:${issue.id}:synthesis`
      : issue.state === "failed"
        ? `branch:${issue.id}:failed-merge`
        : issue.state === "synthesizing"
          ? `branch:${issue.id}:synthesis`
          : undefined;
    for (const item of nodes.values()) {
      if (!item.id.startsWith(`${branchId}:analysis:`)) continue;
      if (!item.meta.file) {
        addUniqueEdge(edges, topologyEdges, branchId, item.id, "spawnFan");
      }
      if (synthesisId && (!issue.files?.synthesis || !item.meta.file)) {
        addUniqueEdge(edges, topologyEdges, item.id, synthesisId, "feedFan");
      }
    }
  }

  const model = { nodes, edges, layout: new Map(), maxIter, observerCount };
  layoutGraph(model);
  return model;
}

export function layoutGraph(model) {
  const observerCount = model.observerCount ?? 1;
  const issueLaneOffsets = new Map();
  const issueOriginX = new Map();
  for (const item of model.nodes.values()) {
    let x = iterBaseX(item.iter);
    let y = 0;
    if (item.kind === "branch") {
      const originIndex = Number.isInteger(item.meta.originObserverIndex) ? item.meta.originObserverIndex : 0;
      x = item.meta.deadlockAnchor
        ? observerX(item.iter) + (iterBaseX(item.iter + 1) - observerX(item.iter)) / 2
        : observerX(item.iter);
      issueOriginX.set(item.meta.issueId, x);
      y = observerY(originIndex, observerCount);
    } else if (item.kind === "observer") {
      const index = Number(item.id.match(/observer-(\d+)$/)?.[1] ?? 0);
      x = observerX(item.iter);
      y = observerY(index, observerCount);
    } else if (item.kind === "analysis" || item.kind === "synthesis") {
      const issueId = item.meta.issueId;
      if (!issueLaneOffsets.has(issueId)) issueLaneOffsets.set(issueId, 0);
      const originX = issueOriginX.get(issueId) ?? observerX(item.iter);
      const nextWorkerX = iterBaseX(item.iter + 1);
      const nextReviewerX = observerX(item.iter + 1);
      if (item.kind === "analysis") {
        const ordinal = issueLaneOffsets.get(issueId);
        issueLaneOffsets.set(issueId, ordinal + 1);
        x = (originX + nextWorkerX) / 2;
        y = ANALYSIS_Y + ordinal * ANALYSIS_DY;
      } else {
        const totalAnalyses = Math.max(1, issueLaneOffsets.get(issueId));
        x = (nextWorkerX + nextReviewerX) / 2;
        y = ANALYSIS_Y + ((totalAnalyses - 1) / 2) * ANALYSIS_DY;
      }
    } else {
      x = iterBaseX(item.iter);
    }
    model.layout.set(item.id, { x, y });
  }
  return model.layout;
}

export function activeNodeId(state, model) {
  if (isTerminal(state.status)) return `iter-${Math.max(1, state.iter ?? model.maxIter ?? 1)}.worker`;
  if (String(state.currentActor || "").startsWith("issue.")) {
    const issueId = String(state.currentActor).slice("issue.".length);
    return [...model.nodes.keys()].find((id) => id.startsWith(`branch:${issueId}:`) && id.includes(":synthesis"))
      ?? [...model.nodes.keys()].find((id) => id.startsWith(`branch:${issueId}:analysis:`));
  }
  const runningIssueNode = [...model.nodes.values()]
    .filter((item) => item.status === "running" && (item.kind === "analysis" || item.kind === "synthesis"))
    .sort((a, b) => {
      const issueCompare = String(b.meta.issueId ?? "").localeCompare(String(a.meta.issueId ?? ""));
      if (issueCompare !== 0) return issueCompare;
      const aWorker = String(a.id).includes(":analysis:worker-") ? 0 : 1;
      const bWorker = String(b.id).includes(":analysis:worker-") ? 0 : 1;
      if (aWorker !== bWorker) return aWorker - bWorker;
      if (a.kind === b.kind) return a.id.localeCompare(b.id);
      return a.kind === "synthesis" ? -1 : 1;
    })[0];
  if (runningIssueNode) return runningIssueNode.id;
  if (state.currentActor === "observers") return `iter-${state.iter}.observer-0`;
  return `iter-${Math.max(1, state.iter ?? 1)}.worker`;
}

export function tooltipForNode(item) {
  const model = item.meta.model ? `${item.meta.model.provider}:${item.meta.model.model}${item.meta.model.effort ? `:${item.meta.model.effort}` : ""}` : "-";
  return {
    title: item.meta.title ?? item.id,
    lines: [
      `Status: ${item.status}`,
      `Iteration: ${item.iter}`,
      `Model: ${model}`,
      item.meta.verdict ? `Verdict: ${item.meta.verdict}` : undefined,
      item.meta.flag ? `Issue: ${item.meta.flag}` : undefined,
      item.meta.summary,
    ].filter(Boolean),
  };
}

function drawDiamond(ctx, x, y, half, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x, y + half);
  ctx.lineTo(x - half, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawDiamondPulse(ctx, x, y, half, roundness) {
  const offset = Math.max(0, Math.min(half * 0.38, roundness));
  if (offset <= 0.01) {
    ctx.beginPath();
    ctx.moveTo(x, y - half);
    ctx.lineTo(x + half, y);
    ctx.lineTo(x, y + half);
    ctx.lineTo(x - half, y);
    ctx.closePath();
    ctx.stroke();
    return;
  }
  const top = { x, y: y - half };
  const right = { x: x + half, y };
  const bottom = { x, y: y + half };
  const left = { x: x - half, y };
  const inset = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: from.x + (dx / length) * offset, y: from.y + (dy / length) * offset };
  };

  ctx.beginPath();
  const start = inset(top, right);
  ctx.moveTo(start.x, start.y);
  let before = inset(right, top);
  let after = inset(right, bottom);
  ctx.lineTo(before.x, before.y);
  ctx.quadraticCurveTo(right.x, right.y, after.x, after.y);
  before = inset(bottom, right);
  after = inset(bottom, left);
  ctx.lineTo(before.x, before.y);
  ctx.quadraticCurveTo(bottom.x, bottom.y, after.x, after.y);
  before = inset(left, bottom);
  after = inset(left, top);
  ctx.lineTo(before.x, before.y);
  ctx.quadraticCurveTo(left.x, left.y, after.x, after.y);
  before = inset(top, left);
  after = start;
  ctx.lineTo(before.x, before.y);
  ctx.quadraticCurveTo(top.x, top.y, after.x, after.y);
  ctx.stroke();
}

function parseHexColor(hex) {
  const clean = String(hex || "#ff6b1a").replace("#", "");
  const value = clean.length === 3
    ? clean.split("").map((char) => char + char).join("")
    : clean.padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgba(color, alpha = color.a ?? 1) {
  return `rgba(${color.r},${color.g},${color.b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function mixColor(from, to, t) {
  const ease = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(from.r + (to.r - from.r) * ease),
    g: Math.round(from.g + (to.g - from.g) * ease),
    b: Math.round(from.b + (to.b - from.b) * ease),
    a: from.a + ((to.a ?? 1) - (from.a ?? 1)) * ease,
  };
}

export function nodeVisualColor(item = {}) {
  const status = item.status;
  const hex = status === "idle" ? "#3a3a3a"
    : status === "failed" || status === "blocking" ? "#ef4444"
      : status === "cancelled" ? "#737373"
        : status === "non-blocking" ? "#eab308"
          : item.iterColor ?? "#ff6b1a";
  const alpha = status === "idle" ? 0.22
    : status === "cancelled" ? 0.38
      : status === "running" ? 0.96
        : 0.84;
  return { hex, alpha, ...parseHexColor(hex), a: alpha };
}

function edgeOpacity(kind) {
  if (kind === "forwardFeed") return 0.62;
  if (kind === "spawnFan" || kind === "feedFan" || kind === "resolutionArc") return 0.76;
  return 1;
}

function edgeBaseWidth(kind) {
  if (kind === "trunk") return 2.7;
  if (kind === "review") return 2.35;
  if (kind === "spawnFan" || kind === "feedFan") return 2.05;
  return 1.9;
}

export function edgeWidthAt(kind, t) {
  const base = edgeBaseWidth(kind);
  const clamped = Math.max(0, Math.min(1, t));
  const startBulge = 2.35 * Math.exp(-clamped * 18);
  const endBulge = 1.15 * Math.exp(-Math.pow((1 - clamped) / 0.075, 2));
  const waist = 0.2 * Math.exp(-Math.pow((clamped - 0.55) / 0.32, 2));
  return base * (1 - waist + startBulge + endBulge);
}

function curveControls(from, to, kind) {
  const midX = (from.x + to.x) / 2;
  if (kind === "resolutionArc") {
    return [{ x: midX, y: from.y + 48 }, { x: midX, y: to.y + 48 }];
  }
  if (kind === "spawnFan" || kind === "feedFan" || kind === "forwardFeed" || kind === "review" || (kind === "trunk" && from.y !== to.y)) {
    return [{ x: midX, y: from.y }, { x: midX, y: to.y }];
  }
  return undefined;
}

function cubicPoint(from, c1, c2, to, t) {
  const inv = 1 - t;
  return {
    x: inv ** 3 * from.x + 3 * inv ** 2 * t * c1.x + 3 * inv * t ** 2 * c2.x + t ** 3 * to.x,
    y: inv ** 3 * from.y + 3 * inv ** 2 * t * c1.y + 3 * inv * t ** 2 * c2.y + t ** 3 * to.y,
  };
}

function curvePoint(from, to, kind, t) {
  const controls = curveControls(from, to, kind);
  if (!controls) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  return cubicPoint(from, controls[0], controls[1], to, t);
}

function curveNormal(points, index) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function drawLine(ctx, from, to, kind, fromNode, toNode) {
  const fromColor = nodeVisualColor(fromNode);
  const toColor = nodeVisualColor(toNode);
  const opacity = edgeOpacity(kind);
  const segments = 52;
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curvePoint(from, to, kind, t);
    points.push({ ...point, t, normal: { x: 0, y: 1 } });
  }
  for (let index = 0; index < points.length; index += 1) {
    points[index].normal = curveNormal(points, index);
  }

  ctx.save();
  ctx.setLineDash([]);
  for (let index = 0; index < segments; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const color = mixColor(fromColor, toColor, (a.t + b.t) / 2);
    const halfA = edgeWidthAt(kind, a.t) / 2;
    const halfB = edgeWidthAt(kind, b.t) / 2;
    const overlap = 0.65;
    ctx.strokeStyle = rgba(color, color.a * opacity);
    ctx.fillStyle = rgba(color, color.a * opacity);
    ctx.beginPath();
    ctx.moveTo(a.x + a.normal.x * (halfA + overlap), a.y + a.normal.y * (halfA + overlap));
    ctx.lineTo(b.x + b.normal.x * (halfB + overlap), b.y + b.normal.y * (halfB + overlap));
    ctx.lineTo(b.x - b.normal.x * (halfB + overlap), b.y - b.normal.y * (halfB + overlap));
    ctx.lineTo(a.x - a.normal.x * (halfA + overlap), a.y - a.normal.y * (halfA + overlap));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function canvasPoint(event, canvas, view) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - canvas.clientWidth / 2 - view.x) / view.zoom,
    y: (event.clientY - rect.top - canvas.clientHeight / 2 - view.y) / view.zoom,
  };
}

export function createCanvasView(nodes) {
  const canvas = nodes.canvas;
  const ctx = canvas?.getContext?.("2d");
  const view = { x: -iterWidth(), y: -70, zoom: 1, autoFollow: true };
  const state = { loop: {}, graph: undefined, activity: [], model: buildGraphModel({}, undefined, []), hovered: undefined, frame: 0, dragging: undefined };

  function resize() {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    render();
  }

  function update(loopState, graph, activity) {
    state.loop = loopState ?? state.loop;
    state.graph = graph ?? state.graph;
    state.activity = activity ?? state.activity;
    state.model = buildGraphModel(state.loop, state.graph, state.activity);
    render();
  }

  function render() {
    if (!canvas || !ctx) return;
    cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(draw);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let followDistance = 0;
    if (view.autoFollow) {
      const target = state.model.layout.get(activeNodeId(state.loop, state.model));
      if (target) {
        const targetX = -target.x;
        const targetY = (h * 0.12) - target.y;
        followDistance = Math.hypot(targetX - view.x, targetY - view.y);
        view.x += (targetX - view.x) * 0.08;
        view.y += (targetY - view.y) * 0.08;
      }
    }

    ctx.setTransform(view.zoom * dpr, 0, 0, view.zoom * dpr, (w / 2 + view.x) * dpr, (h / 2 + view.y) * dpr);

    for (let iter = 1; iter <= state.model.maxIter; iter += 1) {
      const x = iterBaseX(iter);
      ctx.fillStyle = "#737373";
      ctx.font = "11px ui-monospace, Consolas, monospace";
      ctx.fillText(`iter ${iter}`, x - 18, -18);
    }

    const edgeOrder = ["forwardFeed", "spawnFan", "feedFan", "review", "trunk"];
    for (const kind of edgeOrder) {
      for (const edge of state.model.edges.filter((item) => item.kind === kind)) {
        const from = state.model.layout.get(edge.from);
        const to = state.model.layout.get(edge.to);
        const fromNode = state.model.nodes.get(edge.from);
        const toNode = state.model.nodes.get(edge.to);
        if (from && to) drawLine(ctx, from, to, kind, fromNode, toNode);
      }
    }

    const time = performance.now();
    const ringPhase = (time % 1400) / 1400;
    const ringT = Math.min(1, ringPhase / 0.7);
    const ringAlpha = ringPhase < 0.7 ? 0.55 * (1 - ringT) : 0;
    const shapeGlow = 6 + 6 * (0.5 + 0.5 * Math.sin((time / 900) * Math.PI * 2));
    for (const item of state.model.nodes.values()) {
      const point = state.model.layout.get(item.id);
      if (!point) continue;
      if (item.kind === "branch") continue;
      const running = item.status === "running";
      const color = nodeVisualColor(item).hex;
      const baseRadius = item.kind === "worker" ? 9 : item.kind === "analysis" ? 7 : 10;
      if (running) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(255,107,26,${ringAlpha})`;
        if (item.kind === "worker") {
          ctx.beginPath();
          ctx.arc(point.x, point.y, baseRadius + 14 * ringT, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const half = baseRadius + 14 * ringT;
          drawDiamondPulse(ctx, point.x, point.y, half, half * ringT);
        }
      }
      ctx.lineWidth = item.status === "failed" || item.status === "blocking" ? 3 : 1.5;
      ctx.save();
      if (running) {
        ctx.shadowColor = "rgba(255,107,26,0.85)";
        ctx.shadowBlur = shapeGlow;
      }
      if (item.kind === "worker") {
        ctx.fillStyle = color;
        ctx.strokeStyle = "#0a0a0a";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        drawDiamond(ctx, point.x, point.y, item.kind === "analysis" ? 7 : 10, item.kind === "synthesis" ? "#0a0a0a" : color, color);
      }
      ctx.restore();
      if (item.kind === "worker") {
        ctx.fillStyle = "#fafafa";
        ctx.font = "9px ui-monospace, Consolas, monospace";
        ctx.textAlign = "center";
        ctx.fillText(String(item.iter), point.x, point.y + 25);
      }
    }

    if (([...state.model.nodes.values()].some((item) => item.status === "running") || followDistance > 0.5) && !nodes.canvasCard.hidden) {
      state.frame = requestAnimationFrame(draw);
    }
  }

  function hitTest(event) {
    const point = canvasPoint(event, canvas, view);
    let hit;
    for (const item of state.model.nodes.values()) {
      const loc = state.model.layout.get(item.id);
      if (!loc) continue;
      const dx = point.x - loc.x;
      const dy = point.y - loc.y;
      const size = item.kind === "worker" ? 11 : item.kind === "analysis" ? 9 : 12;
      const inside = item.kind === "worker" ? dx * dx + dy * dy <= size * size : Math.abs(dx) + Math.abs(dy) <= size;
      if (inside) hit = item;
    }
    state.hovered = hit;
    if (hit && nodes.tooltip) {
      const tip = tooltipForNode(hit);
      nodes.tooltip.hidden = false;
      nodes.tooltip.style.left = `${event.offsetX + 14}px`;
      nodes.tooltip.style.top = `${event.offsetY + 14}px`;
      nodes.tooltip.replaceChildren();
      const title = document.createElement("strong");
      title.textContent = tip.title;
      nodes.tooltip.append(title, ...tip.lines.map((line) => {
        const div = document.createElement("div");
        div.textContent = line;
        return div;
      }));
    } else if (nodes.tooltip) {
      nodes.tooltip.hidden = true;
    }
    render();
  }

  canvas?.addEventListener("pointerdown", (event) => {
    view.autoFollow = false;
    state.dragging = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas?.addEventListener("pointermove", (event) => {
    if (state.dragging) {
      view.x = state.dragging.vx + event.clientX - state.dragging.x;
      view.y = state.dragging.vy + event.clientY - state.dragging.y;
      render();
    } else {
      hitTest(event);
    }
  });
  canvas?.addEventListener("pointerup", () => {
    state.dragging = undefined;
  });
  canvas?.addEventListener("pointerleave", () => {
    state.dragging = undefined;
    if (nodes.tooltip) nodes.tooltip.hidden = true;
  });
  nodes.reset?.addEventListener("click", () => {
    view.autoFollow = true;
    render();
  });
  if (typeof ResizeObserver !== "undefined" && nodes.canvasCard) {
    new ResizeObserver(resize).observe(nodes.canvasCard);
  }
  resize();

  function centerNode(id) {
    const point = state.model.layout.get(id);
    if (!point || !canvas) return;
    view.autoFollow = false;
    view.x = -point.x;
    view.y = canvas.clientHeight * 0.12 - point.y;
    render();
  }

  return { update, resize, render, centerNode, view, state };
}
