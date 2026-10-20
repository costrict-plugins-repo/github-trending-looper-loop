import { expect, test } from "bun:test";
import path from "node:path";
import { readPreviewGraph } from "../../driver/branches/graph";
import { IssueState } from "../../driver/dispute/machine";
import { ProposedResolution, SynthesisKind } from "../../driver/dispute/protocol";
import {
  IssueSource,
  createIssue,
  listIssues,
  startIssueAnalyses,
  writeIssueAnalysis,
  writeIssueAnalysisFailure,
  writeIssueSynthesis,
} from "../../driver/dispute/store";
import { loopDir } from "../../driver/paths";
import { AgentProvider, ReasoningEffort, type ModelRef } from "../../driver/runners/types";
import { NotifyKind, configPath, writeJson, type LoopConfig } from "../../driver/state";
import { tempWorkspace } from "./helpers";

const worker: ModelRef = { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.Low };
const reviewer: ModelRef = { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low };

const dispute = {
  flag: "Dates rule requires Luxon",
  raisedInIter: 6,
  workerPosition: "Luxon is absent and no date parsing changed.",
  proposedResolution: ProposedResolution.ScopeException,
  evidence: ["package.json has no Luxon dependency"],
};

async function writeConfig(root: string, workspaceDir: string): Promise<void> {
  await writeJson(configPath(root), {
    loopId: path.basename(root),
    workspaceDir,
    task: "secret user prompt",
    maxIter: 10,
    worker,
    observers: [reviewer],
    stopCondition: "done",
    notify: [NotifyKind.Sound],
  } satisfies LoopConfig);
}

test("preview graph exposes a narrow DTO with model refs but not raw config", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-preview-graph");
  await writeConfig(root, workspaceDir);

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer, originObserverIndex: 1 });
  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysis(root, issue.id, {
    name: "reviewer-codex-gpt-55-0",
    specId: "reviewer-0",
    role: "reviewer",
    model: reviewer,
    modelIndex: 0,
  }, "reviewer finished first");
  await writeIssueAnalysis(root, issue.id, {
    name: "worker-claude-opus-0",
    specId: "worker-0",
    role: "worker",
    model: worker,
    modelIndex: 0,
  }, "worker finished second");

  const payload = await readPreviewGraph(root);
  expect(payload.worker).toEqual(worker);
  expect(payload.observers).toEqual([reviewer]);
  expect("task" in payload).toBe(false);
  expect("workspaceDir" in payload).toBe(false);
  expect(payload.issues[0]).toMatchObject({
    id: "issue-001",
    originObserverIndex: 1,
    state: IssueState.Synthesizing,
  });
  expect(payload.issues[0].analysisNodes.map((node) => [node.specId, node.role, node.model?.model])).toEqual([
    ["reviewer-0", "reviewer", "gpt-5.5"],
    ["worker-0", "worker", "opus"],
  ]);
});

test("preview branch graph uses stable analysis spec ids instead of completion order", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-preview-stable-ids");
  await writeConfig(root, workspaceDir);

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });
  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysis(root, issue.id, {
    name: "reviewer-codex-gpt-55-0",
    specId: "reviewer-0",
    role: "reviewer",
    model: reviewer,
    modelIndex: 0,
  }, "reviewer finished first");
  await writeIssueAnalysis(root, issue.id, {
    name: "worker-claude-opus-0",
    specId: "worker-0",
    role: "worker",
    model: worker,
    modelIndex: 0,
  }, "worker finished second");

  const graph = (await readPreviewGraph(root)).branchGraph;
  expect(graph.nodes.map((node) => node.id)).toContain("branch:issue-001:analysis:reviewer-0");
  expect(graph.nodes.map((node) => node.id)).toContain("branch:issue-001:analysis:worker-0");
  expect(graph.nodes.map((node) => node.id)).not.toContain("branch:issue-001:analysis:1");
  expect(graph.edges).toContainEqual({ from: "branch:issue-001", to: "branch:issue-001:analysis:reviewer-0", kind: "spawns" });
});

test("all-failed issue payload has no synthesis so UI can render a virtual failed merge", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-preview-all-failed");
  await writeConfig(root, workspaceDir);

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });
  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysisFailure(root, issue.id, {
    name: "worker-claude-opus-0",
    specId: "worker-0",
    role: "worker",
    model: worker,
    modelIndex: 0,
  }, "worker failed");
  await writeIssueAnalysisFailure(root, issue.id, {
    name: "reviewer-codex-gpt-55-0",
    specId: "reviewer-0",
    role: "reviewer",
    model: reviewer,
    modelIndex: 0,
  }, "reviewer failed");

  const payload = await readPreviewGraph(root);
  expect(payload.issues[0].state).toBe(IssueState.Failed);
  expect(payload.issues[0].files.synthesis).toBeUndefined();
  expect(payload.branchGraph.nodes.some((node) => node.id === "branch:issue-001:synthesis")).toBe(false);
});

test("completed synthesis keeps feed edges tied to stable spec ids", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-preview-synthesis");
  await writeConfig(root, workspaceDir);

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });
  await startIssueAnalyses(root, issue.id, 1);
  await writeIssueAnalysis(root, issue.id, {
    name: "worker-claude-opus-0",
    specId: "worker-0",
    role: "worker",
    model: worker,
    modelIndex: 0,
  }, "worker analysis");
  const stored = (await listIssues(root))[0];
  await writeIssueSynthesis(root, stored.id, "synthesis", {
    issueId: stored.id,
    kind: SynthesisKind.NonBlocking,
    reason: "Carry it forward.",
  });

  const graph = (await readPreviewGraph(root)).branchGraph;
  expect(graph.edges).toContainEqual({ from: "branch:issue-001:analysis:worker-0", to: "branch:issue-001:synthesis", kind: "feeds" });
});
