import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { IssueState } from "../../driver/dispute/machine";
import {
  IssueSource,
  cancelIssues,
  cancelOpenIssues,
  createIssue,
  disputesPath,
  issueToOpenQuestion,
  listIssues,
  saveIssue,
  startIssueAnalyses,
  writeIssueAnalysis,
  writeIssueAnalysisFailure,
  writeIssueSynthesis,
} from "../../driver/dispute/store";
import { ProposedResolution, SynthesisKind } from "../../driver/dispute/protocol";
import { loopDir } from "../../driver/paths";
import { AgentProvider, ReasoningEffort, type ModelRef } from "../../driver/runners/types";
import { readJson } from "../../driver/state";
import { tempWorkspace } from "./helpers";

const dispute = {
  flag: "Dates rule requires Luxon",
  raisedInIter: 6,
  workerPosition: "Luxon is absent and no date parsing changed.",
  proposedResolution: ProposedResolution.ScopeException,
  evidence: ["package.json has no Luxon dependency"],
};

const workerModel: ModelRef = { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.Low };
const reviewerModel: ModelRef = { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low };

test("issue store creates canonical issue files", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issues");

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  expect(issue.id).toBe("issue-001");
  expect(issue.state).toBe(IssueState.Open);
  expect(existsSync(path.join(root, "issues", "issue-001", "issue.md"))).toBe(true);
  expect(existsSync(path.join(root, "issues", "issue-001", "dispute.json"))).toBe(true);
  expect(existsSync(path.join(root, "issues", "issue-001", "issue.json"))).toBe(true);
  expect(existsSync(disputesPath(root))).toBe(true);
  expect(await readFile(issue.files.issue, "utf8")).toContain("Dates rule requires Luxon");

  const listed = await listIssues(root);
  expect(listed).toHaveLength(1);
  expect(listed[0].flag).toBe(dispute.flag);
  expect(await readJson(disputesPath(root))).toHaveLength(1);
});

test("issue store persists observer origin for observer-sourced issues only", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-origin");

  const observerIssue = await createIssue(root, {
    dispute: { ...dispute, flag: "Observer issue" },
    source: IssueSource.Observer,
    originObserverIndex: 2,
  });
  const deadlockIssue = await createIssue(root, {
    dispute: { ...dispute, flag: "Deadlock issue" },
    source: IssueSource.DeadlockDetector,
    originObserverIndex: 2,
  });

  expect(observerIssue.originObserverIndex).toBe(2);
  expect(deadlockIssue.originObserverIndex).toBeUndefined();
  const listed = await listIssues(root);
  expect(listed.find((issue) => issue.id === observerIssue.id)?.originObserverIndex).toBe(2);
  expect(listed.find((issue) => issue.id === deadlockIssue.id)?.originObserverIndex).toBeUndefined();
});

test("issue store persists stable analysis identity for success and failure records", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-analysis-identity");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysis(root, issue.id, {
    name: "worker-claude-opus-0",
    specId: "worker-0",
    role: "worker",
    model: workerModel,
    modelIndex: 0,
  }, "worker analysis");
  await writeIssueAnalysisFailure(root, issue.id, {
    name: "reviewer-codex-gpt-55-0",
    specId: "reviewer-0",
    role: "reviewer",
    model: reviewerModel,
    modelIndex: 0,
  }, "reviewer failed");

  const [stored] = await listIssues(root);
  expect(stored.analysisNodes.map((node) => ({
    specId: node.specId,
    role: node.role,
    model: node.model,
    modelIndex: node.modelIndex,
    status: node.status,
  }))).toEqual([
    { specId: "worker-0", role: "worker", model: workerModel, modelIndex: 0, status: "completed" },
    { specId: "reviewer-0", role: "reviewer", model: reviewerModel, modelIndex: 0, status: "failed" },
  ]);
});

test("issue store calls onMutate after each dispute write commits", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-mutate-hook");
  const events: string[] = [];
  const mark = (name: string) => ({ onMutate: () => { events.push(name); } });

  const issue = await createIssue(root, { dispute, source: IssueSource.Observer }, mark("create"));
  await startIssueAnalyses(root, issue.id, 2, mark("start"));
  await writeIssueAnalysis(root, issue.id, "worker-opus", "worker analysis", mark("analysis"));
  await writeIssueAnalysisFailure(root, issue.id, "reviewer-opus", "reviewer failed", mark("failure"));
  await writeIssueSynthesis(root, issue.id, "synthesis", {
    issueId: issue.id,
    kind: SynthesisKind.NonBlocking,
    reason: "Carry it forward.",
  }, mark("synthesis"));
  await cancelIssues(root, [issue.id], true, mark("cancel"));
  await cancelOpenIssues(root, mark("cancel-open"));

  expect(events).toEqual(["create", "start", "analysis", "failure", "synthesis", "cancel", "cancel-open"]);
});

test("issue store appends analysis and synthesis artifacts", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issues-artifacts");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  const analysisFile = await writeIssueAnalysis(root, issue.id, "worker-claude-opus", "analysis text");
  const withSynthesis = await writeIssueSynthesis(root, issue.id, "synthesis text", {
    issueId: issue.id,
    kind: SynthesisKind.NonBlocking,
    reason: "This can be carried to the result.",
    recommendedInstructionForWorker: "Do not add Luxon.",
  });

  expect(existsSync(analysisFile)).toBe(true);
  expect(withSynthesis.files.analyses).toContain(analysisFile);
  expect(withSynthesis.files.synthesis).toEndWith(path.join("issue-001", "synthesis.md"));
  expect(withSynthesis.state).toBe(IssueState.NonBlocking);
  expect(withSynthesis.files.synthesisJson).toEndWith(path.join("issue-001", "synthesis.json"));
});

test("issue store applies analysis lifecycle transitions", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-lifecycle");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  const analyzing = await startIssueAnalyses(root, issue.id, 2);
  expect(analyzing.state).toBe(IssueState.Analyzing);
  expect(analyzing.machine.pendingAnalyses).toBe(2);

  await writeIssueAnalysis(root, issue.id, "worker-opus", "worker analysis");
  const mid = (await listIssues(root))[0];
  expect(mid.state).toBe(IssueState.Analyzing);
  expect(mid.machine.pendingAnalyses).toBe(1);
  expect(mid.machine.completedAnalyses).toBe(1);

  await writeIssueAnalysis(root, issue.id, "reviewer-opus", "reviewer analysis");
  const ready = (await listIssues(root))[0];
  expect(ready.state).toBe(IssueState.Synthesizing);
  expect(ready.machine.pendingAnalyses).toBe(0);
  expect(ready.machine.completedAnalyses).toBe(2);
});

test("issue store tracks failed analyses without counting them as completed", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-analysis-failure");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await startIssueAnalyses(root, issue.id, 2);
  const failedFile = await writeIssueAnalysisFailure(root, issue.id, "reviewer-opus", "analysis failed");
  const mid = (await listIssues(root))[0];
  expect(existsSync(failedFile)).toBe(true);
  expect(mid.files.analyses).toContain(failedFile);
  expect(mid.state).toBe(IssueState.Analyzing);
  expect(mid.machine.pendingAnalyses).toBe(1);
  expect(mid.machine.completedAnalyses).toBe(0);
  expect(mid.machine.failedAnalyses).toBe(1);

  await writeIssueAnalysis(root, issue.id, "worker-opus", "worker analysis");
  const ready = (await listIssues(root))[0];
  expect(ready.state).toBe(IssueState.Synthesizing);
  expect(ready.machine.pendingAnalyses).toBe(0);
  expect(ready.machine.completedAnalyses).toBe(1);
  expect(ready.machine.failedAnalyses).toBe(1);
});

test("issue store marks issue failed when every analysis fails", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-all-analysis-failed");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysisFailure(root, issue.id, "worker-opus", "worker failed");
  await writeIssueAnalysisFailure(root, issue.id, "reviewer-opus", "reviewer failed");

  const failed = (await listIssues(root))[0];
  expect(failed.state).toBe(IssueState.Failed);
  expect(failed.machine.pendingAnalyses).toBe(0);
  expect(failed.machine.completedAnalyses).toBe(0);
  expect(failed.machine.failedAnalyses).toBe(2);
  expect(failed.files.analyses.map((file) => path.basename(file)).sort()).toEqual([
    "analysis-reviewer-opus.md",
    "analysis-worker-opus.md",
  ]);
});

test("issue store rejects synthesis for a different issue id", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-issue-mismatch");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await expect(writeIssueSynthesis(root, issue.id, "bad synthesis", {
    issueId: "issue-999",
    kind: SynthesisKind.NonBlocking,
    reason: "Wrong issue.",
  })).rejects.toThrow("Synthesis issueId mismatch");
});

test("non-blocking and blocking issues convert to open questions", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-open-question");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });
  const saved = await saveIssue(root, {
    ...issue,
    state: IssueState.Blocking,
    synthesis: {
      issueId: issue.id,
      kind: SynthesisKind.Blocking,
      reason: "Migration strategy is ambiguous.",
      blockReason: "Continuing may implement the wrong public API.",
      userQuestion: "Which migration strategy should be used?",
    },
  });

  expect(issueToOpenQuestion(saved)).toEqual({
    issueId: "issue-001",
    flag: dispute.flag,
    state: IssueState.Blocking,
    summary: "Migration strategy is ambiguous.",
    blockReason: "Continuing may implement the wrong public API.",
    userQuestion: "Which migration strategy should be used?",
    files: {
      issue: saved.files.issue,
      synthesis: undefined,
      analyses: [],
    },
  });
});

test("concurrent issue creates receive distinct ids", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-concurrent-issues");

  const created = await Promise.all([
    createIssue(root, { dispute: { ...dispute, flag: "A" }, source: IssueSource.Observer }),
    createIssue(root, { dispute: { ...dispute, flag: "B" }, source: IssueSource.Observer }),
    createIssue(root, { dispute: { ...dispute, flag: "C" }, source: IssueSource.Observer }),
  ]);

  expect(created.map((issue) => issue.id).sort()).toEqual(["issue-001", "issue-002", "issue-003"]);
  expect(await listIssues(root)).toHaveLength(3);
});

test("concurrent analysis writes do not lose files", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-concurrent-analysis");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await Promise.all([
    writeIssueAnalysis(root, issue.id, "worker-opus", "worker analysis"),
    writeIssueAnalysis(root, issue.id, "reviewer-opus", "reviewer analysis"),
  ]);

  const [stored] = await listIssues(root);
  expect(stored.files.analyses.map((file) => path.basename(file)).sort()).toEqual([
    "analysis-reviewer-opus.md",
    "analysis-worker-opus.md",
  ]);
});

test("cancelOpenIssues cancels non-terminal issues only", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-cancel-issues");
  const open = await createIssue(root, { dispute: { ...dispute, flag: "Open" }, source: IssueSource.Observer });
  const done = await createIssue(root, { dispute: { ...dispute, flag: "Done" }, source: IssueSource.Observer });
  await saveIssue(root, { ...done, state: IssueState.NonBlocking, machine: { ...done.machine, state: IssueState.NonBlocking } });

  const issues = await cancelOpenIssues(root);

  expect(issues.find((issue) => issue.id === open.id)?.state).toBe(IssueState.Cancelled);
  expect(issues.find((issue) => issue.id === done.id)?.state).toBe(IssueState.NonBlocking);
});

test("synthesis cannot reopen a cancelled issue", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-cancel-before-synthesis");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });
  await cancelOpenIssues(root);

  const afterSynthesis = await writeIssueSynthesis(root, issue.id, "late synthesis", {
    issueId: issue.id,
    kind: SynthesisKind.NonBlocking,
    reason: "Too late.",
  });

  expect(afterSynthesis.state).toBe(IssueState.Cancelled);
  expect(existsSync(path.join(root, "issues", issue.id, "synthesis.json"))).toBe(false);
});
