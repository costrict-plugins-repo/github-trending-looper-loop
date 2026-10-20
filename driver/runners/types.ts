export enum AgentRole {
  Worker = "worker",
  Observer = "observer",
}

export enum AgentProvider {
  ClaudeCli = "claude-cli",
  CodexCli = "codex-cli",
}

export enum TurnKind {
  Work = "work",
  Log = "log",
  Observe = "observe",
}

export enum TurnOutcome {
  Completed = "completed",
  TimedOut = "timed-out",
  Failed = "failed",
}

export enum RunnerOutputFormat {
  StreamJson = "stream-json",
  PlainText = "plain-text",
}

export enum ReasoningEffort {
  Low = "low",
  Medium = "medium",
  High = "high",
  XHigh = "xhigh",
}

export type ModelRef = {
  provider: AgentProvider;
  model: string;
  effort?: ReasoningEffort;
};

export abstract class ConversationRef {
  abstract readonly provider: AgentProvider;
}

export class ClaudeConversationRef extends ConversationRef {
  readonly provider = AgentProvider.ClaudeCli;

  constructor(readonly sessionId: string) {
    super();
  }
}

export class CodexConversationRef extends ConversationRef {
  readonly provider = AgentProvider.CodexCli;

  constructor(readonly conversationId: string) {
    super();
  }
}

export type TurnRequest = {
  role: AgentRole;
  kind: TurnKind;
  model: ModelRef;
  prompt: string;
  timeoutMs: number;
  conversationRef?: ConversationRef;
  permissions?: { skip?: boolean };
};

export type RunnerContext = {
  workspaceDir: string;
  promptFilePath?: string;
  env?: Record<string, string>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onProcessStart?: (pid: number) => void;
  onProcessExit?: () => void;
  abortSignal?: AbortSignal;
};

export type TurnResult = {
  provider: AgentProvider;
  model: string;
  outcome: TurnOutcome;
  conversationRef?: ConversationRef;
  finalAssistantText: string;
  exitCode?: number;
  error?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
};

export interface ConversationRunner<TRef extends ConversationRef = ConversationRef> {
  readonly provider: AgentProvider;
  readonly supportsResume: boolean;
  readonly outputFormat: RunnerOutputFormat;

  startTurn(request: TurnRequest, context: RunnerContext): Promise<TurnResult>;
  resumeTurn(request: TurnRequest & { conversationRef: TRef }, context: RunnerContext): Promise<TurnResult>;
}

export enum WorkerSignal {
  Done = "done",
  Abort = "abort",
  None = "none",
}

export enum ObserverVerdict {
  Done = "done",
  Continue = "continue",
  Abort = "abort",
  Failed = "failed",
}

export enum FinalDecision {
  Done = "DONE",
  Continue = "CONTINUE",
  Abort = "ABORT",
  NeedsUser = "NEEDS_USER",
}

export function assertProvider(ref: ConversationRef | undefined, provider: AgentProvider): void {
  if (ref && ref.provider !== provider) {
    throw new Error(`ConversationRef provider mismatch: expected ${provider}, got ${ref.provider}`);
  }
}
