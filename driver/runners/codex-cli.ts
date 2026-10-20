import { type LocalCommand, runLocalCommand } from "./local-process";
import { buildPromptInput } from "./prompt-input";
import { parseStreamJsonLines } from "./stream-json";
import {
  AgentProvider,
  CodexConversationRef,
  ReasoningEffort,
  RunnerOutputFormat,
  TurnOutcome,
  assertProvider,
  type ConversationRunner,
  type RunnerContext,
  type TurnRequest,
  type TurnResult,
} from "./types";

export type CodexRunnerOptions = {
  command?: string;
  prefixArgs?: string[];
  streamJson?: boolean;
};

type BuildArgsParams = {
  model: string;
  effort: ReasoningEffort;
  streamJson: boolean;
  resumeRef?: CodexConversationRef;
};

function buildCodexArgs({ model, effort, streamJson, resumeRef }: BuildArgsParams): string[] {
  const effortArg = `model_reasoning_effort="${effort}"`;
  const serviceTierArg = 'service_tier="fast"';
  const jsonFlag = streamJson ? ["--json"] : [];
  const common = ["--model", model, "-c", effortArg, "-c", serviceTierArg];
  if (resumeRef) {
    return [
      "exec",
      "resume",
      ...jsonFlag,
      ...common,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      resumeRef.conversationId,
      "-",
    ];
  }
  return [
    "exec",
    ...jsonFlag,
    ...common,
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "-",
  ];
}

export function createCodexRunner(options: CodexRunnerOptions = {}): ConversationRunner<CodexConversationRef> {
  const command: LocalCommand = {
    command: options.command ?? "codex",
    prefixArgs: options.prefixArgs,
  };
  const streamJson = options.streamJson ?? true;

  async function run({ request, context, resumeRef }: { request: TurnRequest; context: RunnerContext; resumeRef?: CodexConversationRef }): Promise<TurnResult> {
    assertProvider(request.conversationRef, AgentProvider.CodexCli);
    const promptInput = buildPromptInput(request, context);
    const args = buildCodexArgs({
      model: request.model.model,
      effort: request.model.effort ?? ReasoningEffort.High,
      streamJson,
      resumeRef,
    });

    const processResult = await runLocalCommand({
      command,
      args,
      context,
      timeoutMs: request.timeoutMs,
      stdinText: promptInput,
    });
    if (streamJson) {
      try {
        const parsed = parseStreamJsonLines(processResult.stdoutLines, AgentProvider.CodexCli);
        return {
          provider: AgentProvider.CodexCli,
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
          provider: AgentProvider.CodexCli,
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
      provider: AgentProvider.CodexCli,
      model: request.model.model,
      outcome: processResult.outcome,
      conversationRef: resumeRef,
      finalAssistantText: processResult.stdoutLines.join("\n").trim(),
      exitCode: processResult.exitCode,
      error: processResult.error,
    };
  }

  return {
    provider: AgentProvider.CodexCli,
    supportsResume: streamJson,
    outputFormat: streamJson ? RunnerOutputFormat.StreamJson : RunnerOutputFormat.PlainText,
    startTurn: (request, context) => run({ request, context }),
    resumeTurn: async (request, context) => {
      if (!streamJson) {
        throw new Error("codex-cli runner does not support resume without json output");
      }
      return run({ request, context, resumeRef: request.conversationRef });
    },
  };
}
