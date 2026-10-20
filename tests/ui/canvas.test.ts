import { expect, test } from "bun:test";
import { activeNodeId, buildGraphModel, edgeWidthAt, mergeActivityHistory, nodeVisualColor, tooltipForNode } from "../../ui/canvas.js";

const worker = { provider: "claude-cli", model: "opus", effort: "low" };
const reviewer = { provider: "codex-cli", model: "gpt-5.5", effort: "low" };
const secondReviewer = { provider: "claude-cli", model: "sonnet", effort: "low" };
const thirdReviewer = { provider: "codex-cli", model: "gpt-5.4", effort: "low" };

function graph(overrides: Record<string, unknown> = {}) {
  return {
    worker,
    observers: [reviewer],
    branchGraph: { nodes: [], edges: [] },
    issues: [],
    ...overrides,
  };
}

test("canvas layout is deterministic for the same graph and activity inputs", () => {
  const activity = [
    { iter: 1, stage: "worker-log", status: "done", title: "Worker finished", updatedAt: "2026-01-01T00:00:01.000Z" },
    { iter: 1, stage: "observer", status: "done", title: "Reviewer finished", updatedAt: "2026-01-01T00:00:02.000Z" },
  ];
  const payload = graph({
    issues: [{
      id: "issue-001",
      flag: "Check scope",
      raisedInIter: 1,
      source: "observer",
      state: "synthesizing",
      machine: { totalAnalyses: 2, pendingAnalyses: 0, completedAnalyses: 2, failedAnalyses: 0, warnings: [] },
      originObserverIndex: 0,
      analysisNodes: [
        { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "completed", name: "worker", file: "worker.md" },
        { specId: "reviewer-0", role: "reviewer", model: reviewer, modelIndex: 0, status: "completed", name: "reviewer", file: "reviewer.md" },
      ],
      files: { issue: "issue.md", analyses: ["worker.md", "reviewer.md"] },
    }],
  });

  const first = buildGraphModel({ status: "analyzing-dispute", iter: 1, maxIter: 2 }, payload, activity);
  const second = buildGraphModel({ status: "analyzing-dispute", iter: 1, maxIter: 2 }, payload, activity);
  expect([...first.layout.entries()]).toEqual([...second.layout.entries()]);
  expect(first.edges).toEqual(second.edges);
});

test("canvas edge visuals taper from a wider start into a slimmer middle and fuller node merge", () => {
  const start = edgeWidthAt("trunk", 0.02);
  const afterStart = edgeWidthAt("trunk", 0.18);
  const middle = edgeWidthAt("trunk", 0.5);
  const beforeEnd = edgeWidthAt("trunk", 0.88);
  const end = edgeWidthAt("trunk", 0.98);

  expect(start).toBeGreaterThan(middle);
  expect(end).toBeGreaterThan(middle);
  expect(start).toBeGreaterThan(end);
  expect(afterStart).toBeLessThan(start * 0.55);
  expect(beforeEnd).toBeLessThan(end * 0.75);
});

test("canvas node visual colors fade disabled nodes for edge gradients", () => {
  const idle = nodeVisualColor({ status: "idle", iterColor: "#ff6b1a" });
  const done = nodeVisualColor({ status: "done", iterColor: "#ff6b1a" });
  const failed = nodeVisualColor({ status: "failed", iterColor: "#ff6b1a" });

  expect(idle.hex).toBe("#3a3a3a");
  expect(idle.alpha).toBeLessThan(done.alpha);
  expect(done.hex).toBe("#ff6b1a");
  expect(failed.hex).toBe("#ef4444");
});

test("canvas creates running placeholders from expected spec ids while issue analyses are in flight", () => {
  const model = buildGraphModel({ status: "analyzing-dispute", iter: 2, maxIter: 4 }, graph({
    issues: [{
      id: "issue-001",
      flag: "Needs side review",
      raisedInIter: 2,
      source: "observer",
      state: "analyzing",
      machine: { totalAnalyses: 2, pendingAnalyses: 1, completedAnalyses: 1, failedAnalyses: 0, warnings: [] },
      originObserverIndex: 0,
      analysisNodes: [
        { specId: "reviewer-0", role: "reviewer", model: reviewer, modelIndex: 0, status: "completed", name: "reviewer", file: "reviewer.md" },
      ],
      files: { issue: "issue.md", analyses: ["reviewer.md"] },
    }],
  }), []);

  expect(model.nodes.get("branch:issue-001:analysis:reviewer-0")?.status).toBe("done");
  expect(model.nodes.get("branch:issue-001:analysis:worker-0")?.status).toBe("running");
  expect(model.nodes.has("branch:issue-001:analysis:legacy-1")).toBe(false);
});

test("canvas stacks same-iteration reviewers in one centered review column", () => {
  const model = buildGraphModel({ status: "observers-running", currentActor: "observers", iter: 1, maxIter: 3 }, graph({
    observers: [reviewer, secondReviewer, thirdReviewer],
  }), []);

  const worker1 = model.layout.get("iter-1.worker")!;
  const worker2 = model.layout.get("iter-2.worker")!;
  const reviewerA = model.layout.get("iter-1.observer-0")!;
  const reviewerB = model.layout.get("iter-1.observer-1")!;
  const reviewerC = model.layout.get("iter-1.observer-2")!;

  expect(reviewerA.x).toBe(reviewerB.x);
  expect(reviewerB.x).toBe(reviewerC.x);
  expect(reviewerB.x).toBe((worker1.x + worker2.x) / 2);
  expect(reviewerA.y).toBeLessThan(reviewerB.y);
  expect(reviewerB.y).toBe(0);
  expect(reviewerC.y).toBeGreaterThan(reviewerB.y);
});

test("canvas fans parallel reviewers into the next worker instead of chaining reviewers", () => {
  const model = buildGraphModel({ status: "worker-running", currentActor: "worker.turn1", iter: 2, maxIter: 3 }, graph({
    observers: [reviewer, secondReviewer],
  }), []);

  expect(model.edges).toContainEqual({ from: "iter-1.worker", to: "iter-1.observer-0", kind: "review" });
  expect(model.edges).toContainEqual({ from: "iter-1.worker", to: "iter-1.observer-1", kind: "review" });
  expect(model.edges).toContainEqual({ from: "iter-1.observer-0", to: "iter-2.worker", kind: "trunk" });
  expect(model.edges).toContainEqual({ from: "iter-1.observer-1", to: "iter-2.worker", kind: "trunk" });
  expect(model.edges).not.toContainEqual({ from: "iter-1.observer-0", to: "iter-1.observer-1", kind: "trunk" });
  expect(model.edges).not.toContainEqual({ from: "iter-1.observer-0", to: "iter-1.observer-1", kind: "review" });
});

test("canvas consumes branchGraph topology for completed dispute edges", () => {
  const baseIssue = {
    id: "issue-001",
    flag: "Completed branch",
    raisedInIter: 1,
    source: "observer",
    state: "non-blocking",
    machine: { totalAnalyses: 1, pendingAnalyses: 0, completedAnalyses: 1, failedAnalyses: 0, warnings: [] },
    originObserverIndex: 0,
    analysisNodes: [
      { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "completed", name: "worker", file: "worker.md" },
    ],
    synthesis: { issueId: "issue-001", kind: "non-blocking", reason: "Fine." },
    files: { issue: "issue.md", synthesis: "synthesis.md", analyses: ["worker.md"] },
  };
  const withoutTopology = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({ issues: [baseIssue] }), []);
  expect(withoutTopology.edges).not.toContainEqual({ from: "branch:issue-001", to: "branch:issue-001:analysis:worker-0", kind: "spawnFan" });
  expect(withoutTopology.edges).not.toContainEqual({ from: "branch:issue-001:analysis:worker-0", to: "branch:issue-001:synthesis", kind: "feedFan" });

  const withTopology = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({
    issues: [baseIssue],
    branchGraph: {
      nodes: [],
      edges: [
        { from: "branch:issue-001", to: "branch:issue-001:analysis:worker-0", kind: "spawns" },
        { from: "branch:issue-001:analysis:worker-0", to: "branch:issue-001:synthesis", kind: "feeds" },
      ],
    },
  }), []);
  expect(withTopology.edges).toContainEqual({ from: "branch:issue-001", to: "branch:issue-001:analysis:worker-0", kind: "spawnFan" });
  expect(withTopology.edges).toContainEqual({ from: "branch:issue-001:analysis:worker-0", to: "branch:issue-001:synthesis", kind: "feedFan" });
});

test("canvas renders a virtual failed merge marker only when failed issue has no synthesis file", () => {
  const model = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({
    issues: [{
      id: "issue-001",
      flag: "All analyzers failed",
      raisedInIter: 1,
      source: "observer",
      state: "failed",
      machine: { totalAnalyses: 2, pendingAnalyses: 0, completedAnalyses: 0, failedAnalyses: 2, warnings: [] },
      analysisNodes: [
        { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "failed", name: "worker", file: "worker.md" },
        { specId: "reviewer-0", role: "reviewer", model: reviewer, modelIndex: 0, status: "failed", name: "reviewer", file: "reviewer.md" },
      ],
      files: { issue: "issue.md", analyses: ["worker.md", "reviewer.md"] },
    }],
  }), []);

  const marker = model.nodes.get("branch:issue-001:failed-merge");
  expect(marker?.status).toBe("failed");
  expect(marker?.meta.file).toBeUndefined();
  expect(tooltipForNode(marker!).lines.some((line) => line.startsWith("File:"))).toBe(false);
  expect(model.edges).toContainEqual({ from: "branch:issue-001:analysis:worker-0", to: "branch:issue-001:failed-merge", kind: "feedFan" });
});

test("canvas origin fallback lands resolution arc on first observer", () => {
  const model = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({
    issues: [{
      id: "issue-001",
      flag: "Legacy origin",
      raisedInIter: 1,
      source: "observer",
      state: "non-blocking",
      machine: { totalAnalyses: 1, pendingAnalyses: 0, completedAnalyses: 1, failedAnalyses: 0, warnings: [] },
      analysisNodes: [
        { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "completed", name: "worker", file: "worker.md" },
      ],
      synthesis: { issueId: "issue-001", kind: "non-blocking", reason: "Fine." },
      files: { issue: "issue.md", synthesis: "synthesis.md", analyses: ["worker.md"] },
    }],
  }), []);

  expect(model.edges).toContainEqual({ from: "branch:issue-001:synthesis", to: "iter-1.observer-0", kind: "resolutionArc" });
});

test("canvas invalid observer origin falls back to first observer", () => {
  const model = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({
    issues: [{
      id: "issue-001",
      flag: "Bad origin",
      raisedInIter: 1,
      source: "observer",
      state: "non-blocking",
      machine: { totalAnalyses: 1, pendingAnalyses: 0, completedAnalyses: 1, failedAnalyses: 0, warnings: [] },
      originObserverIndex: 99,
      analysisNodes: [
        { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "completed", name: "worker", file: "worker.md" },
      ],
      synthesis: { issueId: "issue-001", kind: "non-blocking", reason: "Fine." },
      files: { issue: "issue.md", synthesis: "synthesis.md", analyses: ["worker.md"] },
    }],
  }), []);

  expect(model.edges).toContainEqual({ from: "branch:issue-001:synthesis", to: "iter-1.observer-0", kind: "resolutionArc" });
  expect(model.edges.some((edge) => edge.to === "iter-1.observer-99")).toBe(false);
});

test("canvas deadlock issues resolve into a synthetic branch anchor", () => {
  const model = buildGraphModel({ status: "done", iter: 2, maxIter: 2 }, graph({
    issues: [{
      id: "issue-001",
      flag: "Deadlock",
      raisedInIter: 1,
      source: "deadlock-detector",
      state: "non-blocking",
      machine: { totalAnalyses: 1, pendingAnalyses: 0, completedAnalyses: 1, failedAnalyses: 0, warnings: [] },
      analysisNodes: [
        { specId: "worker-0", role: "worker", model: worker, modelIndex: 0, status: "completed", name: "worker", file: "worker.md" },
      ],
      synthesis: { issueId: "issue-001", kind: "non-blocking", reason: "Fine." },
      files: { issue: "issue.md", synthesis: "synthesis.md", analyses: ["worker.md"] },
    }],
  }), []);

  expect(model.edges).toContainEqual({ from: "branch:issue-001:synthesis", to: "branch:issue-001", kind: "resolutionArc" });
  expect(model.nodes.get("branch:issue-001")?.meta.deadlockAnchor).toBe(true);
});

test("canvas folds activity by stable identity so state tail updates replace history rows", () => {
  const merged = mergeActivityHistory(
    [{ iter: 1, stage: "observer", observerId: "observer-1", status: "running", title: "Reviewer", updatedAt: "1" }],
    [{ iter: 1, stage: "observer", observerId: "observer-1", status: "done", title: "Reviewer", updatedAt: "2" }],
  );
  expect(merged).toHaveLength(1);
  expect(merged[0].status).toBe("done");
});

test("active node follows running issue branches ahead of trunk actors", () => {
  const model = buildGraphModel({ status: "worker-running", currentActor: "worker.turn1", iter: 3, maxIter: 4 }, graph({
    issues: [{
      id: "issue-002",
      flag: "Still analyzing",
      raisedInIter: 2,
      source: "observer",
      state: "analyzing",
      machine: { totalAnalyses: 2, pendingAnalyses: 2, completedAnalyses: 0, failedAnalyses: 0, warnings: [] },
      analysisNodes: [],
      files: { issue: "issue.md", analyses: [] },
    }],
  }), []);
  expect(activeNodeId({ status: "worker-running", currentActor: "worker.turn1", iter: 3 }, model)).toBe("branch:issue-002:analysis:worker-0");
});

test("active node follows the newest running issue when branches overlap", () => {
  const model = buildGraphModel({ status: "worker-running", currentActor: "worker.turn1", iter: 3, maxIter: 4 }, graph({
    issues: [
      {
        id: "issue-001",
        flag: "Older",
        raisedInIter: 1,
        source: "observer",
        state: "analyzing",
        machine: { totalAnalyses: 1, pendingAnalyses: 1, completedAnalyses: 0, failedAnalyses: 0, warnings: [] },
        analysisNodes: [],
        files: { issue: "older.md", analyses: [] },
      },
      {
        id: "issue-002",
        flag: "Newer",
        raisedInIter: 2,
        source: "observer",
        state: "analyzing",
        machine: { totalAnalyses: 1, pendingAnalyses: 1, completedAnalyses: 0, failedAnalyses: 0, warnings: [] },
        analysisNodes: [],
        files: { issue: "newer.md", analyses: [] },
      },
    ],
  }), []);
  expect(activeNodeId({ status: "worker-running", currentActor: "worker.turn1", iter: 3 }, model)).toBe("branch:issue-002:analysis:worker-0");
});
