import { expect, test } from "bun:test";
import {
  IssueEventKind,
  IssueResolutionKind,
  IssueState,
  initialIssueMachineState,
  isTerminalIssueState,
  issueEventKinds,
  issueStates,
  transitionIssue,
  type IssueEvent,
  type IssueMachineState,
} from "../../driver/dispute/machine";

const synthesis = (kind: IssueResolutionKind, blockReason?: string) => ({
  kind,
  blockReason,
});

function eventFor(kind: IssueEventKind): IssueEvent {
  switch (kind) {
    case IssueEventKind.Raise:
      return { kind, analyses: 1 };
    case IssueEventKind.AnalysisCompleted:
    case IssueEventKind.AnalysisFailed:
    case IssueEventKind.AnalysisFailedAll:
    case IssueEventKind.SynthesisFailed:
    case IssueEventKind.LoopEnded:
      return { kind };
    case IssueEventKind.Synthesis:
      return { kind, verdict: synthesis(IssueResolutionKind.Resolved) };
  }
}

function analyzing(pendingAnalyses: number, completedAnalyses = 0, failedAnalyses = 0): IssueMachineState {
  return {
    state: IssueState.Analyzing,
    totalAnalyses: pendingAnalyses + completedAnalyses + failedAnalyses,
    pendingAnalyses,
    completedAnalyses,
    failedAnalyses,
    warnings: [],
  };
}

test("all issue states and event kinds are enumerable", () => {
  expect(issueStates).toEqual([
    IssueState.Open,
    IssueState.Analyzing,
    IssueState.Synthesizing,
    IssueState.Resolved,
    IssueState.NonBlocking,
    IssueState.Blocking,
    IssueState.Cancelled,
    IssueState.Failed,
  ]);
  expect(issueEventKinds).toEqual([
    IssueEventKind.Raise,
    IssueEventKind.AnalysisCompleted,
    IssueEventKind.AnalysisFailed,
    IssueEventKind.AnalysisFailedAll,
    IssueEventKind.Synthesis,
    IssueEventKind.SynthesisFailed,
    IssueEventKind.LoopEnded,
  ]);
});

test("open issue raises into analyzing when analysis nodes exist", () => {
  const next = transitionIssue(initialIssueMachineState(), { kind: IssueEventKind.Raise, analyses: 3 });
  expect(next).toMatchObject({
    state: IssueState.Analyzing,
    totalAnalyses: 3,
    pendingAnalyses: 3,
    completedAnalyses: 0,
    failedAnalyses: 0,
  });
});

test("open issue fails when raised with zero analysis nodes", () => {
  const next = transitionIssue(initialIssueMachineState(), { kind: IssueEventKind.Raise, analyses: 0 });
  expect(next.state).toBe(IssueState.Failed);
  expect(next.warnings).toContain("Issue raised without analysis nodes.");
});

test("analysis completion stays analyzing while work remains, then synthesizes", () => {
  const oneLeft = transitionIssue(analyzing(2), { kind: IssueEventKind.AnalysisCompleted });
  expect(oneLeft).toMatchObject({ state: IssueState.Analyzing, pendingAnalyses: 1, completedAnalyses: 1 });

  const done = transitionIssue(oneLeft, { kind: IssueEventKind.AnalysisCompleted });
  expect(done).toMatchObject({ state: IssueState.Synthesizing, pendingAnalyses: 0, completedAnalyses: 2 });
});

test("analysis failures synthesize if at least one analysis completed", () => {
  const next = transitionIssue(analyzing(1, 1), { kind: IssueEventKind.AnalysisFailed });
  expect(next).toMatchObject({ state: IssueState.Synthesizing, pendingAnalyses: 0, completedAnalyses: 1, failedAnalyses: 1 });
});

test("analysis failures fail the issue if every analysis failed", () => {
  const next = transitionIssue(analyzing(1), { kind: IssueEventKind.AnalysisFailed });
  expect(next).toMatchObject({ state: IssueState.Failed, pendingAnalyses: 0, completedAnalyses: 0, failedAnalyses: 1 });
});

test("analysisFailedAll only fails when no analysis completed or remains pending", () => {
  const guarded = transitionIssue(analyzing(2), { kind: IssueEventKind.AnalysisFailedAll });
  expect(guarded.state).toBe(IssueState.Analyzing);
  expect(guarded.warnings[0]).toContain("ignored");

  const next = transitionIssue({ ...analyzing(0), totalAnalyses: 2 }, { kind: IssueEventKind.AnalysisFailedAll });
  expect(next).toMatchObject({ state: IssueState.Failed, pendingAnalyses: 0, failedAnalyses: 2 });
});

test("synthesis verdict maps to terminal issue states", () => {
  const base = { ...analyzing(0, 1), state: IssueState.Synthesizing };
  expect(transitionIssue(base, { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.Resolved) }).state).toBe(IssueState.Resolved);
  expect(transitionIssue(base, { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.NonBlocking) }).state).toBe(IssueState.NonBlocking);
  expect(transitionIssue(base, { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.Blocking, "User must choose.") }).state).toBe(IssueState.Blocking);
});

test("blocking synthesis without blockReason downgrades to non-blocking", () => {
  const base = { ...analyzing(0, 1), state: IssueState.Synthesizing };
  const next = transitionIssue(base, { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.Blocking) });
  expect(next.state).toBe(IssueState.NonBlocking);
  expect(next.warnings[0]).toContain("downgraded to non-blocking");
});

test("synthesis failure fails the issue", () => {
  const base = { ...analyzing(0, 1), state: IssueState.Synthesizing };
  expect(transitionIssue(base, { kind: IssueEventKind.SynthesisFailed }).state).toBe(IssueState.Failed);
});

test("loop end cancels every non-terminal state", () => {
  const states = [
    initialIssueMachineState(),
    analyzing(1),
    { ...analyzing(0, 1), state: IssueState.Synthesizing },
  ];
  for (const state of states) {
    expect(transitionIssue(state, { kind: IssueEventKind.LoopEnded }).state).toBe(IssueState.Cancelled);
  }
});

test("terminal states ignore all later events", () => {
  const terminalStates = issueStates.filter(isTerminalIssueState);
  for (const terminal of terminalStates) {
    const state: IssueMachineState = {
      ...initialIssueMachineState(),
      state: terminal,
    };
    for (const kind of issueEventKinds) {
      expect(transitionIssue(state, eventFor(kind))).toEqual(state);
    }
  }
});

test("every state and event pair is deterministic and total", () => {
  for (const stateName of issueStates) {
    const state: IssueMachineState = {
      ...initialIssueMachineState(),
      state: stateName,
      totalAnalyses: stateName === IssueState.Analyzing ? 1 : 0,
      pendingAnalyses: stateName === IssueState.Analyzing ? 1 : 0,
      completedAnalyses: stateName === IssueState.Synthesizing ? 1 : 0,
    };
    for (const kind of issueEventKinds) {
      expect(() => transitionIssue(state, eventFor(kind))).not.toThrow();
      expect(issueStates).toContain(transitionIssue(state, eventFor(kind)).state);
    }
  }
});

test("every terminal state is reachable from open", () => {
  const terminalPaths: Record<IssueState, IssueEvent[]> = {
    [IssueState.Resolved]: [
      { kind: IssueEventKind.Raise, analyses: 1 },
      { kind: IssueEventKind.AnalysisCompleted },
      { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.Resolved) },
    ],
    [IssueState.NonBlocking]: [
      { kind: IssueEventKind.Raise, analyses: 1 },
      { kind: IssueEventKind.AnalysisCompleted },
      { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.NonBlocking) },
    ],
    [IssueState.Blocking]: [
      { kind: IssueEventKind.Raise, analyses: 1 },
      { kind: IssueEventKind.AnalysisCompleted },
      { kind: IssueEventKind.Synthesis, verdict: synthesis(IssueResolutionKind.Blocking, "Need user decision.") },
    ],
    [IssueState.Cancelled]: [{ kind: IssueEventKind.LoopEnded }],
    [IssueState.Failed]: [{ kind: IssueEventKind.Raise, analyses: 0 }],
    [IssueState.Open]: [],
    [IssueState.Analyzing]: [],
    [IssueState.Synthesizing]: [],
  };

  for (const terminal of issueStates.filter(isTerminalIssueState)) {
    const reached = terminalPaths[terminal].reduce(transitionIssue, initialIssueMachineState());
    expect(reached.state).toBe(terminal);
  }
});
