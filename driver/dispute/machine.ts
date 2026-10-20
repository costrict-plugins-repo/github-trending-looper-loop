export enum IssueState {
  Open = "open",
  Analyzing = "analyzing",
  Synthesizing = "synthesizing",
  Resolved = "resolved",
  NonBlocking = "non-blocking",
  Blocking = "blocking",
  Cancelled = "cancelled",
  Failed = "failed",
}

export enum IssueEventKind {
  Raise = "raise",
  AnalysisCompleted = "analysisCompleted",
  AnalysisFailed = "analysisFailed",
  AnalysisFailedAll = "analysisFailedAll",
  Synthesis = "synthesis",
  SynthesisFailed = "synthesisFailed",
  LoopEnded = "loopEnded",
}

export enum IssueResolutionKind {
  Resolved = "resolved",
  NonBlocking = "non-blocking",
  Blocking = "blocking",
}

export type IssueSynthesisVerdict = {
  kind: IssueResolutionKind;
  blockReason?: string;
};

export type IssueMachineState = {
  state: IssueState;
  totalAnalyses: number;
  pendingAnalyses: number;
  completedAnalyses: number;
  failedAnalyses: number;
  warnings: string[];
};

export type IssueEvent =
  | { kind: IssueEventKind.Raise; analyses: number }
  | { kind: IssueEventKind.AnalysisCompleted }
  | { kind: IssueEventKind.AnalysisFailed }
  | { kind: IssueEventKind.AnalysisFailedAll }
  | { kind: IssueEventKind.Synthesis; verdict: IssueSynthesisVerdict }
  | { kind: IssueEventKind.SynthesisFailed }
  | { kind: IssueEventKind.LoopEnded };

export const issueStates = Object.values(IssueState);
export const issueEventKinds = Object.values(IssueEventKind);

export function initialIssueMachineState(): IssueMachineState {
  return {
    state: IssueState.Open,
    totalAnalyses: 0,
    pendingAnalyses: 0,
    completedAnalyses: 0,
    failedAnalyses: 0,
    warnings: [],
  };
}

export function isTerminalIssueState(state: IssueState): boolean {
  return [
    IssueState.Resolved,
    IssueState.NonBlocking,
    IssueState.Blocking,
    IssueState.Cancelled,
    IssueState.Failed,
  ].includes(state);
}

function withWarning(state: IssueMachineState, warning: string): IssueMachineState {
  return { ...state, warnings: [...state.warnings, warning] };
}

function completeOneAnalysis(state: IssueMachineState): IssueMachineState {
  const pendingAnalyses = Math.max(0, state.pendingAnalyses - 1);
  const completedAnalyses = state.completedAnalyses + 1;
  return {
    ...state,
    pendingAnalyses,
    completedAnalyses,
    state: pendingAnalyses === 0 && completedAnalyses >= 1 ? IssueState.Synthesizing : IssueState.Analyzing,
  };
}

function failOneAnalysis(state: IssueMachineState): IssueMachineState {
  const pendingAnalyses = Math.max(0, state.pendingAnalyses - 1);
  const failedAnalyses = state.failedAnalyses + 1;
  if (pendingAnalyses === 0 && state.completedAnalyses === 0) {
    return { ...state, pendingAnalyses, failedAnalyses, state: IssueState.Failed };
  }
  if (pendingAnalyses === 0) {
    return { ...state, pendingAnalyses, failedAnalyses, state: IssueState.Synthesizing };
  }
  return { ...state, pendingAnalyses, failedAnalyses };
}

export function transitionIssue(state: IssueMachineState, event: IssueEvent): IssueMachineState {
  if (isTerminalIssueState(state.state)) {
    return state;
  }

  if (event.kind === IssueEventKind.LoopEnded) {
    return { ...state, state: IssueState.Cancelled };
  }

  switch (state.state) {
    case IssueState.Open:
      if (event.kind !== IssueEventKind.Raise) {
        return state;
      }
      if (event.analyses <= 0) {
        return withWarning({ ...state, state: IssueState.Failed }, "Issue raised without analysis nodes.");
      }
      return {
        ...state,
        state: IssueState.Analyzing,
        totalAnalyses: event.analyses,
        pendingAnalyses: event.analyses,
        completedAnalyses: 0,
        failedAnalyses: 0,
      };

    case IssueState.Analyzing:
      if (event.kind === IssueEventKind.AnalysisCompleted) {
        return completeOneAnalysis(state);
      }
      if (event.kind === IssueEventKind.AnalysisFailed) {
        return failOneAnalysis(state);
      }
      if (event.kind === IssueEventKind.AnalysisFailedAll) {
        if (state.completedAnalyses === 0 && state.pendingAnalyses === 0) {
          return { ...state, failedAnalyses: state.totalAnalyses, state: IssueState.Failed };
        }
        return withWarning(state, "analysisFailedAll ignored because some analyses are still pending or completed.");
      }
      return state;

    case IssueState.Synthesizing:
      if (event.kind === IssueEventKind.SynthesisFailed) {
        return { ...state, state: IssueState.Failed };
      }
      if (event.kind !== IssueEventKind.Synthesis) {
        return state;
      }
      if (event.verdict.kind === IssueResolutionKind.Resolved) {
        return { ...state, state: IssueState.Resolved };
      }
      if (event.verdict.kind === IssueResolutionKind.Blocking && event.verdict.blockReason?.trim()) {
        return { ...state, state: IssueState.Blocking };
      }
      if (event.verdict.kind === IssueResolutionKind.Blocking) {
        return withWarning(
          { ...state, state: IssueState.NonBlocking },
          "Blocking synthesis without blockReason was downgraded to non-blocking.",
        );
      }
      return { ...state, state: IssueState.NonBlocking };
  }
  return state;
}
