import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { IssueState } from "../../driver/dispute/machine";
import { ProposedResolution, SynthesisKind } from "../../driver/dispute/protocol";
import { IssueSource, createIssue, saveIssue } from "../../driver/dispute/store";
import { runLoop } from "../../driver/main";
import { loopDir } from "../../driver/paths";
import { AgentProvider } from "../../driver/runners/types";
import { NotifyKind, readJson, type LoopState } from "../../driver/state";
import { looperloopResult } from "../../mcp/tools/result";
import { mockRegistry, tempWorkspace } from "./helpers";

test("result tool returns user-facing entrypoint, instructions, and iteration files", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-result",
    workspaceDir,
    task: "finish the task",
    maxIter: 2,
    worker: { provider: AgentProvider.ClaudeCli, model: "opus" },
    observers: [{ provider: AgentProvider.ClaudeCli, model: "opus" }],
    stopCondition: "task is finished",
    notify: [] as NotifyKind[],
    registry: mockRegistry({
      workerLogText: "# Worker Log\n\nFinished the task.\n\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });

  const result = await looperloopResult({ workspaceDir, loop_id: "loop-result" });

  expect(result.outcome).toBe("done");
  expect(result.userFacingResult).toContain("Done in 1 of 2 iterations.");
  expect(result.userFacingResult).toContain("# Global State");
  expect(result.entrypoint.kind).toBe("global-state");
  expect(result.entrypoint.file).toEndWith(path.join("loop-result", "global-state.md"));
  expect(result.entrypoint.text).toContain("# Global State");
  expect(result.files.result).toEndWith(path.join("loop-result", "RESULT.json"));
  expect(result.files.iterations).toHaveLength(1);
  expect(result.files.iterations[0].workerLog).toEndWith(path.join("iter-1", "worker.log.md"));
  expect(result.files.iterations[0].verdicts).toEndWith(path.join("iter-1", "verdicts.json"));
  expect(result.files.iterations[0].observerReviews).toHaveLength(1);
  expect(result.files.iterations[0].raw.some((file) => file.endsWith(path.join("iter-1", "worker.turn1.jsonl")))).toBe(true);
  expect(result.instruction).toContain("Present userFacingResult");
  expect(result.instruction).toContain("branchGraph");
  expect(result.branchGraph).toEqual({ nodes: [], edges: [] });
  expect(result.activity).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stage: "worker-log", title: "Worker finished this iteration", summary: expect.stringContaining("goal is complete") }),
      expect.objectContaining({ stage: "observer", title: "opus reviewer finished", summary: expect.stringContaining("agrees the goal is complete") }),
      expect.objectContaining({ stage: "decision", title: "Decision: done", summary: expect.stringContaining("worker and reviewer agree") }),
    ]),
  );

  const state = await readJson<LoopState>(path.join(workspaceDir, "looper", "loop-runs", "loop-result", "state.json"));
  expect(state.resultSummary).toBe("Done in 1 of 2 iterations.");
  expect(state.activity?.some((entry) => entry.stage === "decision")).toBe(true);
});

test("result tool returns full global-state text rather than a truncated preview", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-result-full-text",
    workspaceDir,
    task: "finish the task",
    maxIter: 2,
    worker: { provider: AgentProvider.ClaudeCli, model: "opus" },
    observers: [{ provider: AgentProvider.ClaudeCli, model: "opus" }],
    stopCondition: "task is finished",
    notify: [] as NotifyKind[],
    registry: mockRegistry({
      workerLogText: "# Worker Log\n\nFinished the task.\n\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  const longText = `# Global State\n\n${"x".repeat(13000)}\nTHE_END`;
  await writeFile(path.join(workspaceDir, "looper", "loop-runs", "loop-result-full-text", "global-state.md"), longText, "utf8");

  const result = await looperloopResult({ workspaceDir, loop_id: "loop-result-full-text" });

  expect(result.entrypoint.text).toContain("THE_END");
  expect(result.userFacingResult).toContain("THE_END");
  expect(result.entrypoint.text).not.toContain("truncated");
});

test("result tool exposes non-blocking issue outcomes as open questions", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-result-open-question",
    workspaceDir,
    task: "finish the task",
    maxIter: 2,
    worker: { provider: AgentProvider.ClaudeCli, model: "opus" },
    observers: [{ provider: AgentProvider.ClaudeCli, model: "opus" }],
    stopCondition: "task is finished",
    notify: [] as NotifyKind[],
    registry: mockRegistry({
      workerLogText: "# Worker Log\n\nFinished the task.\n\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  const root = loopDir(workspaceDir, "loop-result-open-question");
  const issue = await createIssue(root, {
    source: IssueSource.Observer,
    dispute: {
      flag: "Dates rule requires Luxon",
      raisedInIter: 1,
      workerPosition: "No date parsing changed.",
      proposedResolution: ProposedResolution.ScopeException,
      evidence: ["package.json"],
    },
  });
  await saveIssue(root, {
    ...issue,
    state: IssueState.NonBlocking,
    synthesis: {
      issueId: issue.id,
      kind: SynthesisKind.NonBlocking,
      reason: "Reviewer cannot approve the exception independently.",
      recommendedInstructionForWorker: "Carry this to the final result.",
    },
  });

  const result = await looperloopResult({ workspaceDir, loop_id: "loop-result-open-question" });

  expect(result.openQuestions).toEqual([
    expect.objectContaining({
      issueId: "issue-001",
      flag: "Dates rule requires Luxon",
      state: "non-blocking",
      summary: "Reviewer cannot approve the exception independently.",
    }),
  ]);
  expect(result.userFacingResult).toContain("Open questions:");
  expect(result.userFacingResult).toContain("Dates rule requires Luxon");
  expect(result.files.issues[0]).toEndWith(path.join("issues", "issue-001"));
  expect(result.branchGraph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "branch:issue-001", branchKind: "dispute", label: "Dates rule requires Luxon" }),
    ]),
  );
});

test("result tool leads with blocking user question for needs-user outcome", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-result-needs-user",
    workspaceDir,
    task: "finish the task",
    maxIter: 2,
    worker: { provider: AgentProvider.ClaudeCli, model: "opus" },
    observers: [{ provider: AgentProvider.ClaudeCli, model: "opus" }],
    stopCondition: "task is finished",
    notify: [] as NotifyKind[],
    registry: mockRegistry({
      workerLogText: "# Worker Log\n\nFinished the task.\n\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  const root = loopDir(workspaceDir, "loop-result-needs-user");
  const issue = await createIssue(root, {
    source: IssueSource.Observer,
    dispute: {
      flag: "Choose migration strategy",
      raisedInIter: 1,
      workerPosition: "Two incompatible strategies exist.",
      proposedResolution: ProposedResolution.NeedsUserDecision,
      evidence: ["api.ts"],
    },
  });
  await saveIssue(root, {
    ...issue,
    state: IssueState.Blocking,
    synthesis: {
      issueId: issue.id,
      kind: SynthesisKind.Blocking,
      reason: "Migration strategy is ambiguous.",
      blockReason: "Continuing may implement the wrong public API.",
      userQuestion: "Should migration preserve the old API?",
    },
  });
  const stateFile = path.join(root, "state.json");
  const state = await readJson<LoopState>(stateFile);
  await writeFile(stateFile, `${JSON.stringify({ ...state, status: "needs-user", resultSummary: "Needs user decision." }, null, 2)}\n`, "utf8");
  const resultFile = path.join(root, "RESULT.json");
  const stored = await readJson(resultFile) as Record<string, unknown>;
  await writeFile(resultFile, `${JSON.stringify({ ...stored, outcome: "needs-user" }, null, 2)}\n`, "utf8");

  const result = await looperloopResult({ workspaceDir, loop_id: "loop-result-needs-user" });

  expect(result.outcome).toBe("needs-user");
  expect(result.userFacingResult.startsWith("Needs user decision:\nShould migration preserve the old API?")).toBe(true);
  expect(result.instruction).toContain("openQuestions[*].userQuestion");
});
