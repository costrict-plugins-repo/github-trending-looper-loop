import { createClaudeRunner } from "./claude-cli";
import { createCodexRunner } from "./codex-cli";
import { AgentProvider, type ConversationRunner } from "./types";

export type RunnerRegistry = Map<AgentProvider, ConversationRunner>;

export function createDefaultRunnerRegistry(): RunnerRegistry {
  return new Map<AgentProvider, ConversationRunner>([
    [AgentProvider.ClaudeCli, createClaudeRunner()],
    [AgentProvider.CodexCli, createCodexRunner()],
  ]);
}

export function getRunner(registry: RunnerRegistry, provider: AgentProvider): ConversationRunner {
  const runner = registry.get(provider);
  if (!runner) {
    throw new Error(`No runner registered for provider ${provider}`);
  }
  return runner;
}
