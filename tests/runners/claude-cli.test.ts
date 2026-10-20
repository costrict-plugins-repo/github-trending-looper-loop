import { expect, test } from "bun:test";
import path from "node:path";
import { createClaudeRunner } from "../../driver/runners/claude-cli";
import { AgentProvider, AgentRole, ClaudeConversationRef, ReasoningEffort, TurnKind, TurnOutcome } from "../../driver/runners/types";

const root = path.resolve(import.meta.dir, "../..");
const mockClaude = path.join(root, "tests", "fixtures", "mock-claude-cli.ts");

test("claude runner extracts session id and resumes it", async () => {
  const runner = createClaudeRunner({ command: "bun", prefixArgs: [mockClaude] });
  const first = await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.ClaudeCli, model: "opus" },
      prompt: "work",
      timeoutMs: 1000,
    },
    { workspaceDir: root },
  );
  expect(first.outcome).toBe(TurnOutcome.Completed);
  expect(first.conversationRef).toBeInstanceOf(ClaudeConversationRef);

  const second = await runner.resumeTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Log,
      model: { provider: AgentProvider.ClaudeCli, model: "opus" },
      prompt: "logging turn",
      timeoutMs: 1000,
      conversationRef: first.conversationRef as ClaudeConversationRef,
    },
    { workspaceDir: root },
  );
  expect(second.finalAssistantText).toContain("COMPLETION_PROMISE_SATISFIED");
});

test("claude runner passes configured model flag and max turns by kind", async () => {
  const runner = createClaudeRunner({ command: "bun", prefixArgs: [mockClaude] });
  const workLines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.ClaudeCli, model: "opus" },
      prompt: "work",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => workLines.push(line) },
  );
  expect(workLines.join("\n")).toContain("--model");
  expect(workLines.join("\n")).toContain("opus");
  expect(workLines.join("\n")).toContain("--effort");
  expect(workLines.join("\n")).toContain("high");
  expect(workLines.join("\n")).toContain("--max-turns");
  expect(workLines.join("\n")).toContain("1000");

  const logLines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Log,
      model: { provider: AgentProvider.ClaudeCli, model: "opus" },
      prompt: "logging turn",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => logLines.push(line) },
  );
  expect(logLines.join("\n")).toContain("--max-turns");
  expect(logLines.join("\n")).toContain("50");

  const observerLines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.ClaudeCli, model: "opus" },
      prompt: "observe",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => observerLines.push(line) },
  );
  expect(observerLines.join("\n")).toContain("--max-turns");
  expect(observerLines.join("\n")).toContain("100");
});

test("claude runner passes requested reasoning effort", async () => {
  const runner = createClaudeRunner({ command: "bun", prefixArgs: [mockClaude] });
  const lines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.ClaudeCli, model: "sonnet", effort: ReasoningEffort.Low },
      prompt: "work",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => lines.push(line) },
  );
  expect(lines.join("\n")).toContain("--effort");
  expect(lines.join("\n")).toContain("low");
});
