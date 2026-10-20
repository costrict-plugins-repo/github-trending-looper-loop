import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  AgentRole,
  AgentProvider,
  ClaudeConversationRef,
  CodexConversationRef,
  TurnOutcome,
  RunnerOutputFormat,
  type ConversationRunner,
  type RunnerContext,
  type TurnRequest,
  type TurnResult,
} from "../../driver/runners/types";
import type { RunnerRegistry } from "../../driver/runners/registry";

process.env.LOOPERLOOP_FAST_RETRY = "1";

export async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "looperloop-test-"));
}

export type MockBehavior = {
  workerLogText?: string;
  observerTexts?: string[];
  failObservers?: boolean;
  failIssueAnalysisRoles?: Array<"worker" | "reviewer">;
  hangWorker?: boolean;
  noConversationRef?: boolean;
  onStartTurn?: (request: TurnRequest) => void | Promise<void>;
};

function issueAnalysisRole(prompt: string): "worker" | "reviewer" | undefined {
  if (!prompt.includes("You are analyzing a LooperLoop disputed issue")) {
    return undefined;
  }
  if (prompt.includes("as the worker perspective")) {
    return "worker";
  }
  if (prompt.includes("as the reviewer perspective")) {
    return "reviewer";
  }
  return undefined;
}

function shouldFailIssueAnalysis(behavior: MockBehavior, request: TurnRequest): boolean {
  const role = issueAnalysisRole(request.prompt);
  return Boolean(role && behavior.failIssueAnalysisRoles?.includes(role));
}

class MockClaudeRunner implements ConversationRunner<ClaudeConversationRef> {
  readonly provider = AgentProvider.ClaudeCli;
  readonly supportsResume = true;
  readonly outputFormat = RunnerOutputFormat.StreamJson;

  constructor(private behavior: MockBehavior) {}

  async startTurn(request: TurnRequest, context: RunnerContext): Promise<TurnResult> {
    await this.behavior.onStartTurn?.(request);
    if (shouldFailIssueAnalysis(this.behavior, request)) {
      context.onStderrLine?.("issue analysis failed");
      return {
        provider: AgentProvider.ClaudeCli,
        model: request.model.model,
        outcome: TurnOutcome.Failed,
        conversationRef: new ClaudeConversationRef("mock-session"),
        finalAssistantText: "",
        error: "issue analysis failed",
      };
    }
    context.onStdoutLine?.(`{"type":"system","session_id":"mock-session"}`);
    const text = request.role === AgentRole.Observer
      ? this.behavior.observerTexts?.[0] ?? "observer review\nOBSERVER_VERDICT: continue"
      : "work done";
    context.onStdoutLine?.(`{"type":"assistant","text":${JSON.stringify(text)}}`);
    if (this.behavior.hangWorker) {
      await new Promise((resolve) => setTimeout(resolve, request.timeoutMs + 20));
      return {
        provider: AgentProvider.ClaudeCli,
        model: request.model.model,
        outcome: TurnOutcome.TimedOut,
        conversationRef: new ClaudeConversationRef("mock-session"),
        finalAssistantText: "partial output before timeout",
      };
    }
    return {
      provider: AgentProvider.ClaudeCli,
      model: request.model.model,
      outcome: TurnOutcome.Completed,
      conversationRef: this.behavior.noConversationRef ? undefined : new ClaudeConversationRef("mock-session"),
      finalAssistantText: text,
    };
  }

  async resumeTurn(request: TurnRequest & { conversationRef: ClaudeConversationRef }, context: RunnerContext): Promise<TurnResult> {
    if (request.conversationRef.provider !== AgentProvider.ClaudeCli) {
      throw new Error("provider mismatch");
    }
    const text = this.behavior.workerLogText ?? "worker log\n";
    context.onStdoutLine?.(`{"type":"assistant","text":${JSON.stringify(text)}}`);
    return {
      provider: AgentProvider.ClaudeCli,
      model: request.model.model,
      outcome: TurnOutcome.Completed,
      conversationRef: request.conversationRef,
      finalAssistantText: text,
    };
  }
}

class MockCodexRunner implements ConversationRunner<CodexConversationRef> {
  readonly provider = AgentProvider.CodexCli;
  readonly supportsResume = true;
  readonly outputFormat = RunnerOutputFormat.StreamJson;
  private index = 0;

  constructor(private behavior: MockBehavior) {}

  async startTurn(request: TurnRequest, context: RunnerContext): Promise<TurnResult> {
    await this.behavior.onStartTurn?.(request);
    if (shouldFailIssueAnalysis(this.behavior, request)) {
      context.onStderrLine?.("issue analysis failed");
      return {
        provider: AgentProvider.CodexCli,
        model: request.model.model,
        outcome: TurnOutcome.Failed,
        conversationRef: new CodexConversationRef("mock-codex-session"),
        finalAssistantText: "",
        error: "issue analysis failed",
      };
    }
    if (this.behavior.failObservers) {
      context.onStderrLine?.("observer failed");
      return {
        provider: AgentProvider.CodexCli,
        model: request.model.model,
        outcome: TurnOutcome.Failed,
        conversationRef: new CodexConversationRef("mock-codex-session"),
        finalAssistantText: "",
        error: "observer failed",
      };
    }
    const text = request.role === AgentRole.Observer
      ? this.behavior.observerTexts?.[this.index++] ?? "observer review\nOBSERVER_VERDICT: continue"
      : "work done";
    context.onStdoutLine?.(text);
    return {
      provider: AgentProvider.CodexCli,
      model: request.model.model,
      outcome: TurnOutcome.Completed,
      conversationRef: new CodexConversationRef("mock-codex-session"),
      finalAssistantText: text,
    };
  }

  async resumeTurn(request: TurnRequest & { conversationRef: CodexConversationRef }, context: RunnerContext): Promise<TurnResult> {
    if (request.conversationRef.provider !== AgentProvider.CodexCli) {
      throw new Error("provider mismatch");
    }
    const text = this.behavior.workerLogText ?? "worker log\n";
    context.onStdoutLine?.(text);
    return {
      provider: AgentProvider.CodexCli,
      model: request.model.model,
      outcome: TurnOutcome.Completed,
      conversationRef: request.conversationRef,
      finalAssistantText: text,
    };
  }
}

export function mockRegistry(behavior: MockBehavior): RunnerRegistry {
  return new Map<AgentProvider, ConversationRunner>([
    [AgentProvider.ClaudeCli, new MockClaudeRunner(behavior)],
    [AgentProvider.CodexCli, new MockCodexRunner(behavior)],
  ]);
}
