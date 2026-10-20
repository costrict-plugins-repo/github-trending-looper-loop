import { expect, test } from "bun:test";
import { createCodexRunner } from "../../driver/runners/codex-cli";
import { AgentProvider, AgentRole, CodexConversationRef, ReasoningEffort, TurnKind, TurnOutcome } from "../../driver/runners/types";

const run = process.env.RUN_REAL_AGENT_TESTS === "1";

test.skipIf(!run)("real codex returns non-empty text", async () => {
  const runner = createCodexRunner();
  const result = await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low },
      prompt: "Say ok.",
      timeoutMs: 60000,
    },
    { workspaceDir: process.cwd() },
  );
  expect(result.outcome).toBe(TurnOutcome.Completed);
  expect(result.finalAssistantText.length).toBeGreaterThan(0);
  expect(result.conversationRef).toBeInstanceOf(CodexConversationRef);
}, 90000);

test.skipIf(!run)("real codex resumes a worker conversation", async () => {
  const runner = createCodexRunner();
  const first = await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low },
      prompt: "Remember the word looperloop-smoke. Reply exactly: ready",
      timeoutMs: 60000,
    },
    { workspaceDir: process.cwd() },
  );
  expect(first.outcome).toBe(TurnOutcome.Completed);
  expect(first.conversationRef).toBeInstanceOf(CodexConversationRef);

  const second = await runner.resumeTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Log,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low },
      prompt: "What word were you asked to remember? Reply with only that word.",
      timeoutMs: 60000,
      conversationRef: first.conversationRef as CodexConversationRef,
    },
    { workspaceDir: process.cwd() },
  );
  expect(second.outcome).toBe(TurnOutcome.Completed);
  expect(second.finalAssistantText.toLowerCase()).toContain("looperloop-smoke");
}, 120000);
