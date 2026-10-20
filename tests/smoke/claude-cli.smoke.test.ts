import { expect, test } from "bun:test";
import { createClaudeRunner } from "../../driver/runners/claude-cli";
import { AgentProvider, AgentRole, ClaudeConversationRef, ReasoningEffort, TurnKind, TurnOutcome } from "../../driver/runners/types";

const run = process.env.RUN_REAL_AGENT_TESTS === "1";

async function expectClaudeWorkerResumes(model: string): Promise<void> {
  const runner = createClaudeRunner();
  const first = await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.ClaudeCli, model, effort: ReasoningEffort.Low },
      prompt: "Say exactly: ok",
      timeoutMs: 60000,
      permissions: { skip: true },
    },
    { workspaceDir: process.cwd() },
  );
  expect(first.outcome).toBe(TurnOutcome.Completed);
  expect(first.finalAssistantText.toLowerCase()).toContain("ok");
  expect(first.conversationRef).toBeInstanceOf(ClaudeConversationRef);

  const second = await runner.resumeTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Log,
      model: { provider: AgentProvider.ClaudeCli, model, effort: ReasoningEffort.Low },
      prompt: "Reply exactly: resumed",
      timeoutMs: 60000,
      permissions: { skip: true },
      conversationRef: first.conversationRef as ClaudeConversationRef,
    },
    { workspaceDir: process.cwd() },
  );
  expect(second.outcome).toBe(TurnOutcome.Completed);
  expect(second.finalAssistantText.toLowerCase()).toContain("resumed");
}

test.skipIf(!run)("real opus worker resumes with low effort", () => expectClaudeWorkerResumes("opus"), 120000);

test.skipIf(!run)("real sonnet worker resumes with low effort", () => expectClaudeWorkerResumes("sonnet"), 120000);

test.skipIf(!run)("real claude exposes mcp_servers shape in init metadata", async () => {
  const lines: string[] = [];
  const runner = createClaudeRunner();
  await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.Low },
      prompt: "Answer briefly.",
      timeoutMs: 60000,
      permissions: { skip: true },
    },
    { workspaceDir: process.cwd(), onStdoutLine: (line) => lines.push(line) },
  );
  expect(lines.some((line) => line.includes("mcp_servers"))).toBe(true);
}, 90000);
