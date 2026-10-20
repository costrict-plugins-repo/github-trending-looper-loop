import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLoop } from "../../driver/main";
import { AgentProvider, ReasoningEffort } from "../../driver/runners/types";
import { LoopStatus, NotifyKind, readState, updateState, writeState } from "../../driver/state";
import { mockRegistry, tempWorkspace } from "./helpers";

const worker = { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.High };
const observers = [{ provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.High }];
const codexWorker = { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.High };
const claudeObservers = [{ provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.High }];

test("worker done plus observer done writes DONE result", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-done",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [NotifyKind.Sound],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.Done);
  expect(state.resultSummary).toBe("Done in 1 of 3 iterations.");
  expect(state.platform).toBe(os.platform());
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-done");
  expect(existsSync(path.join(root, "COMPLETE"))).toBe(true);
  expect(existsSync(path.join(root, "iter-1", "prompt.turn1.md"))).toBe(true);
  expect(existsSync(path.join(root, "iter-1", "observer-iter-1-0-gpt-5.5.prompt.md"))).toBe(true);
  expect(await readFile(path.join(root, "iter-1", "worker.turn1.jsonl"), "utf8")).toContain("mock-session");
  const stored = await readState(root);
  expect(stored.activity?.find((entry) => entry.stage === "worker-log")?.model).toEqual(worker);
  expect(stored.activity?.find((entry) => entry.stage === "observer")?.observerId).toBe("observer-iter-1-0-gpt-5.5");
  expect(stored.activity?.find((entry) => entry.stage === "observer")?.model).toEqual(observers[0]);
});

test("status server stays available during completion grace", async () => {
  const workspaceDir = await tempWorkspace();
  const loopId = "loop-test-status-grace";
  const run = runLoop({
    loopId,
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: true,
    openStatusWindow: false,
    statusGraceMs: 1000,
  });
  const root = path.join(workspaceDir, "looper", "loop-runs", loopId);
  let statusUrl: string | undefined;
  let served: { status?: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      statusUrl = statusUrl ?? (await readState(root)).statusUrl;
      if (statusUrl) {
        served = (await fetch(`${statusUrl}/state`).then((response) => response.json())) as { status?: string };
        if (served.status === LoopStatus.Done) {
          break;
        }
      }
    } catch {
      // State/server may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(statusUrl).toBeTruthy();
  expect(served?.status).toBe(LoopStatus.Done);
  await run;
});

test("worker done plus observer continue runs until max iteration", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-continue",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["not yet\nOBSERVER_VERDICT: continue", "still no\nOBSERVER_VERDICT: continue"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.MaxIterReached);
  expect(state.resultSummary).toBe("Max iterations reached at 3 of 3.");
  const result = JSON.parse(await readFile(path.join(workspaceDir, "looper", "loop-runs", "loop-test-continue", "RESULT.json"), "utf8"));
  expect(result.outcome).toBe("max-iter-reached");
});

test("codex worker plus claude observer can finish the loop", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-codex-worker-claude-observer",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers: claudeObservers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.Done);
  const result = JSON.parse(await readFile(path.join(workspaceDir, "looper", "loop-runs", "loop-test-codex-worker-claude-observer", "RESULT.json"), "utf8"));
  expect(result.config.worker).toEqual(codexWorker);
  expect(result.config.observers).toEqual(claudeObservers);
});

test("codex worker plus codex observer can finish the loop", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-codex-worker-codex-observer",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.Done);
});

test("activity summaries come from agent-written summary blocks", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-agent-summary",
    workspaceDir,
    task: "finish",
    maxIter: 2,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "# Worker Log\n\n```looperloop-summary\nImplemented the requested canvas behavior and covered it with focused tests.\n```\n\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["```looperloop-summary\nVerified the implementation and tests; no follow-up work is needed.\n```\n\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });

  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-agent-summary");
  const stored = await readState(root);
  expect(stored.activity?.find((entry) => entry.stage === "worker-log")?.summary)
    .toBe("Implemented the requested canvas behavior and covered it with focused tests.");
  expect(stored.activity?.find((entry) => entry.stage === "observer")?.summary)
    .toBe("Verified the implementation and tests; no follow-up work is needed.");
});

test("next worker prompt includes observer disagreement when worker claimed done too early", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-disagree-worker-done",
    workspaceDir,
    task: "finish",
    maxIter: 2,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["not yet because checks are missing\nOBSERVER_VERDICT: continue", "still no\nOBSERVER_VERDICT: continue"],
    }),
    openStatus: false,
  });
  const prompt = await readFile(path.join(workspaceDir, "looper", "loop-runs", "loop-test-disagree-worker-done", "iter-2", "prompt.turn1.md"), "utf8");
  expect(prompt).toContain("Last iter you claimed completion but observers disagreed");
  expect(prompt).toContain("not yet because checks are missing");
});

test("next worker prompt asks for completion sentinel when observer thinks goal is done", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-disagree-observer-done",
    workspaceDir,
    task: "finish",
    maxIter: 2,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "log without sentinel",
      observerTexts: ["looks complete\nOBSERVER_VERDICT: done", "looks complete\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  const prompt = await readFile(path.join(workspaceDir, "looper", "loop-runs", "loop-test-disagree-observer-done", "iter-2", "prompt.turn1.md"), "utf8");
  expect(prompt).toContain("Last iter the observer thought the goal looked complete");
  expect(prompt).toContain("COMPLETION_PROMISE_SATISFIED: CONFIRMED");
});

test("worker abort ends with aborted result", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-abort",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "blocked\nWORKER_SELF_ABORT: cannot proceed",
      observerTexts: ["agree\nOBSERVER_VERDICT: abort"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.Aborted);
  expect(state.resultSummary).toBe("Aborted at iteration 1 of 3.");
});

test("all observers failed continues with warning until max iteration", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-failed-observers",
    workspaceDir,
    task: "finish",
    maxIter: 1,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "no sentinel",
      failObservers: true,
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.MaxIterReached);
  expect(state.warnings).toContain("All observers failed; continuing by policy.");
});

test("observer abort ends with aborted result", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-observer-abort",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "not sure yet",
      observerTexts: ["unsafe to continue\nOBSERVER_VERDICT: abort"],
    }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.Aborted);
});

test("worker setup failure skips observers and writes failed verdict", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-worker-fail",
    workspaceDir,
    task: "finish",
    maxIter: 1,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({ noConversationRef: true }),
    openStatus: false,
  });
  expect(state.status).toBe(LoopStatus.MaxIterReached);
  expect(state.resultSummary).toBe("Max iterations reached at 1 of 1.");
  expect(existsSync(path.join(workspaceDir, "looper", "loop-runs", "loop-test-worker-fail", "RESULT.json"))).toBe(true);
  const verdicts = JSON.parse(await readFile(path.join(workspaceDir, "looper", "loop-runs", "loop-test-worker-fail", "iter-1", "verdicts.json"), "utf8"));
  expect(verdicts.observers).toEqual([]);
  expect(verdicts.merged).toBe("failed");
});

test("codex observer writes stream json raw extension", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-raw-log",
    workspaceDir,
    task: "finish",
    maxIter: 1,
    worker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: ["verified\nOBSERVER_VERDICT: done"],
    }),
    openStatus: false,
  });
  const raw = path.join(workspaceDir, "looper", "loop-runs", "loop-test-raw-log", "iter-1", "observer-iter-1-0-gpt-5.5.raw.jsonl");
  expect(existsSync(raw)).toBe(true);
});

test("non-blocking dispute branch is merged into next review and carried to result", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-nonblocking-dispute",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `needs user visibility
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "The worker scope argument is reasonable, but I cannot approve it alone."
  escalate: true
  blocking: false
  reason: "Carry the scope exception to the result."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis: non-blocking",
        "reviewer-model analysis: non-blocking",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: non-blocking
reason: "Luxon is out of scope for this task."
recommended_instruction_for_worker: "Do not add Luxon for this task."
\`\`\``,
        "verified\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.Done);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-nonblocking-dispute");
  const iter1Verdicts = JSON.parse(await readFile(path.join(root, "iter-1", "verdicts.json"), "utf8"));
  const iter2Verdicts = JSON.parse(await readFile(path.join(root, "iter-2", "verdicts.json"), "utf8"));
  const result = JSON.parse(await readFile(path.join(root, "RESULT.json"), "utf8"));
  expect(iter1Verdicts.disputesRaised).toEqual(["issue-001"]);
  expect(iter2Verdicts.disputesMerged).toEqual(["issue-001"]);
  expect(result.outcome).toBe("done");
  expect(existsSync(path.join(root, "issues", "issue-001", "synthesis.json"))).toBe(true);
  const iter2ObserverPrompt = await readFile(path.join(root, "iter-2", "observer-iter-2-0-gpt-5.5.prompt.md"), "utf8");
  expect(iter2ObserverPrompt).toContain("Merged issue-branch context:");
  expect(iter2ObserverPrompt).toContain("files:");
  expect(iter2ObserverPrompt).toContain(path.join(root, "issues", "issue-001", "issue.md"));
  expect(iter2ObserverPrompt).toContain(path.join(root, "issues", "issue-001", "synthesis.md"));
  expect(iter2ObserverPrompt).toContain("analysis-worker-codex-cli-gpt-5.5-0.md");
  expect(iter2ObserverPrompt).toContain("analysis-reviewer-codex-cli-gpt-5.5-0.md");
  expect(iter2ObserverPrompt).toContain("observer_position: The worker scope argument is reasonable, but I cannot approve it alone.");
  expect(iter2ObserverPrompt).toContain("blocking_requested: false");
});

test("issue branch records partial analysis failure and synthesizes from successful analyses", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-partial-analysis-failure",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      failIssueAnalysisRoles: ["reviewer"],
      observerTexts: [
        `needs user visibility
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "The worker scope argument is reasonable, but I cannot approve it alone."
  escalate: true
  blocking: false
  reason: "Carry the scope exception to the result."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis: successful partial data",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: non-blocking
reason: "The successful worker-side analysis is enough to carry this as non-blocking."
recommended_instruction_for_worker: "Do not add Luxon for this task."
\`\`\``,
        "verified\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.Done);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-partial-analysis-failure");
  const issue = JSON.parse(await readFile(path.join(root, "issues", "issue-001", "issue.json"), "utf8"));
  expect(issue.state).toBe("non-blocking");
  expect(issue.machine.completedAnalyses).toBe(1);
  expect(issue.machine.failedAnalyses).toBe(1);
  expect(issue.files.analyses.map((file: string) => path.basename(file)).sort()).toEqual([
    "analysis-reviewer-codex-cli-gpt-5.5-0.md",
    "analysis-worker-codex-cli-gpt-5.5-0.md",
  ]);
  const synthesisPrompt = await readFile(path.join(root, "issues", "issue-001", "synthesis-gpt-5.5.prompt.md"), "utf8");
  expect(synthesisPrompt).toContain("worker-model analysis: successful partial data");
  expect(synthesisPrompt).not.toContain("Analysis failed.");
  expect(synthesisPrompt).toContain("blocking request is not final");
  expect(synthesisPrompt).toContain("The worker cannot continue meaningful safe work around it.");
  expect(synthesisPrompt).toContain("cannot reasonably be carried as a non-blocking result note");
});

test("issue branch marks issue failed when all analyses fail and skips synthesis", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-all-analysis-failed",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      failIssueAnalysisRoles: ["worker", "reviewer"],
      observerTexts: [
        `needs user visibility
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "The worker scope argument is reasonable, but I cannot approve it alone."
  escalate: true
  blocking: false
  reason: "Carry the scope exception to the result."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        "verified\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.Done);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-all-analysis-failed");
  const issue = JSON.parse(await readFile(path.join(root, "issues", "issue-001", "issue.json"), "utf8"));
  const iter2Verdicts = JSON.parse(await readFile(path.join(root, "iter-2", "verdicts.json"), "utf8"));
  expect(issue.state).toBe("failed");
  expect(issue.machine.pendingAnalyses).toBe(0);
  expect(issue.machine.completedAnalyses).toBe(0);
  expect(issue.machine.failedAnalyses).toBe(2);
  expect(iter2Verdicts.disputesMerged).toEqual(["issue-001"]);
  expect(existsSync(path.join(root, "issues", "issue-001", "synthesis.json"))).toBe(false);
});

test("blocking dispute branch ends loop with needs-user", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-blocking-dispute",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `migration needs decision
\`\`\`looperloop-dispute-responses
- flag: "Choose migration strategy"
  observer_position: "Both choices are viable but incompatible."
  escalate: true
  blocking: true
  reason: "Needs user decision."
  block_reason: "Continuing may implement the wrong public API."
  recommended_resolution: ask_user
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis: blocking",
        "reviewer-model analysis: blocking",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: blocking
reason: "Migration strategy is ambiguous."
block_reason: "Continuing may implement the wrong public API."
user_question: "Should migration preserve the old API?"
\`\`\``,
        "looks okay except blocker\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.NeedsUser);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-blocking-dispute");
  const result = JSON.parse(await readFile(path.join(root, "RESULT.json"), "utf8"));
  expect(result.outcome).toBe("needs-user");
  expect(result.reason).toBe("Continuing may implement the wrong public API.");
  const iter2Verdicts = JSON.parse(await readFile(path.join(root, "iter-2", "verdicts.json"), "utf8"));
  expect(iter2Verdicts.final).toBe("NEEDS_USER");
});

test("repeated un-escalated dispute force-opens an issue branch", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-deadlock-detector",
    workspaceDir,
    task: "finish",
    maxIter: 4,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `scope unclear
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Needs visibility."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        `scope still unclear
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I still cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Same unresolved procedural dispute."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis: non-blocking",
        "reviewer-model analysis: non-blocking",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: non-blocking
reason: "Repeated procedural dispute should be carried to result."
\`\`\``,
        "verified\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.Done);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-deadlock-detector");
  const iter2Verdicts = JSON.parse(await readFile(path.join(root, "iter-2", "verdicts.json"), "utf8"));
  expect(iter2Verdicts.disputesRaised).toEqual(["issue-001"]);
  const issue = JSON.parse(await readFile(path.join(root, "issues", "issue-001", "issue.json"), "utf8"));
  expect(issue.source).toBe("deadlock-detector");
});

test("deadlock detector does not count duplicate observers in the same iteration", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-deadlock-same-iter",
    workspaceDir,
    task: "finish",
    maxIter: 1,
    worker: codexWorker,
    observers: [codexWorker, codexWorker],
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `scope unclear
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Needs visibility."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        `same scope concern
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I also cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Needs visibility."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
      ],
    }),
    openStatus: false,
  });

  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-deadlock-same-iter");
  expect(existsSync(path.join(root, "issues"))).toBe(false);
});

test("deadlock detector resets when dispute is not consecutive", async () => {
  const workspaceDir = await tempWorkspace();
  await runLoop({
    loopId: "loop-test-deadlock-gap",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `scope unclear
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Needs visibility."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
        "not done yet\nOBSERVER_VERDICT: continue",
        `scope unclear again
\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "I cannot approve the exception."
  escalate: false
  blocking: false
  reason: "Needs visibility."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
      ],
    }),
    openStatus: false,
  });

  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-deadlock-gap");
  expect(existsSync(path.join(root, "issues"))).toBe(false);
});

test("issue raised on final iteration is cancelled instead of analyzed", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-final-issue-cancelled",
    workspaceDir,
    task: "finish",
    maxIter: 1,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `final issue
\`\`\`looperloop-dispute-responses
- flag: "Final question"
  observer_position: "Needs visibility."
  escalate: true
  blocking: false
  reason: "Raised too late to analyze."
  recommended_resolution: carry_to_result
\`\`\`
OBSERVER_VERDICT: continue`,
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.MaxIterReached);
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-final-issue-cancelled");
  const issue = JSON.parse(await readFile(path.join(root, "issues", "issue-001", "issue.json"), "utf8"));
  expect(issue.state).toBe("cancelled");
});

test("max iteration priority wins over blocking issue synthesis", async () => {
  const workspaceDir = await tempWorkspace();
  const state = await runLoop({
    loopId: "loop-test-max-over-blocking",
    workspaceDir,
    task: "finish",
    maxIter: 2,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      observerTexts: [
        `migration needs decision
\`\`\`looperloop-dispute-responses
- flag: "Choose migration strategy"
  observer_position: "Both choices are viable but incompatible."
  escalate: true
  blocking: true
  reason: "Needs user decision."
  block_reason: "Continuing may implement the wrong public API."
  recommended_resolution: ask_user
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis: blocking",
        "reviewer-model analysis: blocking",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: blocking
reason: "Migration strategy is ambiguous."
block_reason: "Continuing may implement the wrong public API."
user_question: "Should migration preserve the old API?"
\`\`\``,
        "looks okay except blocker\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.MaxIterReached);
});

test("stop during issue branch wait cancels pending issue instead of observing", async () => {
  const workspaceDir = await tempWorkspace();
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-test-stop-during-issue");
  let stopScheduled = false;
  const state = await runLoop({
    loopId: "loop-test-stop-during-issue",
    workspaceDir,
    task: "finish",
    maxIter: 3,
    worker: codexWorker,
    observers,
    stopCondition: "finish is done",
    notify: [],
    registry: mockRegistry({
      workerLogText: "finished\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED",
      onStartTurn: async (request) => {
        if (!stopScheduled && request.prompt.includes("You are analyzing a LooperLoop disputed issue")) {
          stopScheduled = true;
          setTimeout(() => void writeFile(path.join(root, "STOP"), "cancelled by test\n", "utf8"), 10);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      },
      observerTexts: [
        `migration needs decision
\`\`\`looperloop-dispute-responses
- flag: "Choose migration strategy"
  observer_position: "Both choices are viable but incompatible."
  escalate: true
  blocking: true
  reason: "Needs user decision."
  block_reason: "Continuing may implement the wrong public API."
  recommended_resolution: ask_user
\`\`\`
OBSERVER_VERDICT: continue`,
        "worker-model analysis after stop",
        "reviewer-model analysis after stop",
        `synthesis
\`\`\`looperloop-synthesis
issue_id: issue-001
kind: non-blocking
reason: "Should not survive cancellation."
\`\`\``,
        "this observer should not be needed\nOBSERVER_VERDICT: done",
      ],
    }),
    openStatus: false,
  });

  expect(state.status).toBe(LoopStatus.Cancelled);
  const issue = JSON.parse(await readFile(path.join(root, "issues", "issue-001", "issue.json"), "utf8"));
  expect(issue.state).toBe("cancelled");
});

test("concurrent state updates keep state.json valid", async () => {
  const workspaceDir = await tempWorkspace();
  const root = path.join(workspaceDir, "looper", "loop-runs", "loop-state-race");
  await writeState(root, {
    loopId: "loop-state-race",
    workspaceDir,
    iter: 0,
    maxIter: 1,
    status: LoopStatus.Starting,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
  });
  await Promise.all([
    updateState(root, { currentActor: "worker.turn1" }),
    updateState(root, { activeChildPid: 123 }),
    updateState(root, { status: LoopStatus.WorkerRunning }),
    updateState(root, { activeChildPid: undefined }),
  ]);
  const state = await readState(root);
  expect(state.loopId).toBe("loop-state-race");
  expect(state.status).toBe(LoopStatus.WorkerRunning);
});
