import { parseStreamJsonLines } from "./stream-json";
import {
  AgentProvider,
  ClaudeConversationRef,
  TurnOutcome,
  RunnerOutputFormat,
  ReasoningEffort,
  assertProvider,
  TurnKind,
  type ConversationRunner,
  type RunnerContext,
  type TurnRequest,
  type TurnResult,
} from "./types";
import { type LocalCommand, runLocalCommand } from "./local-process";
import { buildPromptInput } from "./prompt-input";

const CLAUDE_MAX_TURNS_BY_KIND: Record<TurnKind, number> = {
  [TurnKind.Work]: 1000,
  [TurnKind.Log]: 50,
  [TurnKind.Observe]: 100,
};

export type ClaudeRunnerOptions = {
  command?: string;
  prefixArgs?: string[];
};

export function createClaudeRunner(options: ClaudeRunnerOptions = {}): ConversationRunner<ClaudeConversationRef> {
  const command: LocalCommand = {
    command: options.command ?? "claude",
    prefixArgs: options.prefixArgs,
  };

  async function run({ request, context, resumeRef }: { request: TurnRequest; context: RunnerContext; resumeRef?: ClaudeConversationRef }): Promise<TurnResult> {
    assertProvider(request.conversationRef, AgentProvider.ClaudeCli);
    const promptInput = buildPromptInput(request, context);
    const args = [
      "-p",
      ...(resumeRef ? ["--resume", resumeRef.sessionId] : []),
      "--model",
      request.model.model,
      "--effort",
      request.model.effort ?? ReasoningEffort.High,
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--max-turns",
      String(CLAUDE_MAX_TURNS_BY_KIND[request.kind]),
      "--settings",
      '{"disableAllHooks":true}',
      "--verbose",
    ];
    if (request.permissions?.skip) {
      args.push("--dangerously-skip-permissions");
    }

    const processResult = await runLocalCommand({
      command,
      args,
      context,
      timeoutMs: request.timeoutMs,
      stdinText: promptInput,
    });
    try {
      const parsed = parseStreamJsonLines(processResult.stdoutLines, AgentProvider.ClaudeCli);
      return {
        provider: AgentProvider.ClaudeCli,
        model: request.model.model,
        outcome: processResult.outcome,
        conversationRef: parsed.conversationRef ?? resumeRef,
        finalAssistantText: parsed.finalAssistantText,
        exitCode: processResult.exitCode,
        error: processResult.error,
        usage: parsed.usage,
      };
    } catch (error) {
      return {
        provider: AgentProvider.ClaudeCli,
        model: request.model.model,
        outcome: processResult.outcome === TurnOutcome.TimedOut ? TurnOutcome.TimedOut : TurnOutcome.Failed,
        conversationRef: resumeRef,
        finalAssistantText: processResult.stdoutLines.join("\n"),
        exitCode: processResult.exitCode,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    provider: AgentProvider.ClaudeCli,
    supportsResume: true,
    outputFormat: RunnerOutputFormat.StreamJson,
    startTurn: (request, context) => run({ request, context }),
    resumeTurn: (request, context) => run({ request, context, resumeRef: request.conversationRef }),
  };
}
