import { expect, test } from "bun:test";
import path from "node:path";
import { createCodexRunner } from "../../driver/runners/codex-cli";
import { parseObserverVerdict } from "../../driver/runners/sentinels";
import { AgentProvider, AgentRole, CodexConversationRef, ObserverVerdict, ReasoningEffort, TurnKind, TurnOutcome } from "../../driver/runners/types";

const root = path.resolve(import.meta.dir, "../..");
const mockCodex = path.join(root, "tests", "fixtures", "mock-codex-cli.ts");

function echoedArgs(lines: string[]): string[] {
  const echo = lines.map((line) => {
    try {
      return JSON.parse(line) as { args?: string[] };
    } catch {
      return {};
    }
  }).find((line) => line.args);
  return echo?.args ?? [];
}

test("codex runner captures plain text observer verdict", async () => {
  const runner = createCodexRunner({ command: "bun", prefixArgs: [mockCodex] });
  const result = await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5" },
      prompt: "observe",
      timeoutMs: 1000,
    },
    { workspaceDir: root },
  );
  expect(result.outcome).toBe(TurnOutcome.Completed);
  expect(parseObserverVerdict(result.finalAssistantText)).toBe(ObserverVerdict.Done);
});

test("codex runner passes configured model flag and advertises resume", async () => {
  const runner = createCodexRunner({ command: "bun", prefixArgs: [mockCodex] });
  const lines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5" },
      prompt: "observe",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => lines.push(line) },
  );
  expect(runner.supportsResume).toBe(true);
  const args = echoedArgs(lines);
  expect(args).toContain("--model");
  expect(args).toContain("gpt-5.5");
  expect(args).toContain("--json");
  expect(args).toContain("-c");
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args).toContain('service_tier="fast"');
});

test("codex runner passes requested reasoning effort", async () => {
  const runner = createCodexRunner({ command: "bun", prefixArgs: [mockCodex] });
  const lines: string[] = [];
  await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low },
      prompt: "work",
      timeoutMs: 1000,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => lines.push(line) },
  );
  expect(echoedArgs(lines)).toContain('model_reasoning_effort="low"');
});

test("codex runner extracts thread id and resumes it", async () => {
  const runner = createCodexRunner({ command: "bun", prefixArgs: [mockCodex] });
  const first = await runner.startTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Work,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5" },
      prompt: "work",
      timeoutMs: 1000,
    },
    { workspaceDir: root },
  );
  expect(first.outcome).toBe(TurnOutcome.Completed);
  expect(first.conversationRef).toBeInstanceOf(CodexConversationRef);

  const lines: string[] = [];
  const second = await runner.resumeTurn(
    {
      role: AgentRole.Worker,
      kind: TurnKind.Log,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5" },
      prompt: "logging turn",
      timeoutMs: 1000,
      conversationRef: first.conversationRef as CodexConversationRef,
    },
    { workspaceDir: root, env: { MOCK_ECHO_ARGS: "1" }, onStdoutLine: (line) => lines.push(line) },
  );
  expect(second.finalAssistantText).toContain("COMPLETION_PROMISE_SATISFIED");
  expect(lines.join("\n")).toContain("resume");
  expect(lines.join("\n")).toContain("mock-codex-thread");
});

test("codex runner can still run plain text observer mode without resume", async () => {
  const runner = createCodexRunner({ command: "bun", prefixArgs: [mockCodex], streamJson: false });
  expect(runner.supportsResume).toBe(false);
  const result = await runner.startTurn(
    {
      role: AgentRole.Observer,
      kind: TurnKind.Observe,
      model: { provider: AgentProvider.CodexCli, model: "gpt-5.5" },
      prompt: "observe",
      timeoutMs: 1000,
    },
    { workspaceDir: root },
  );
  expect(parseObserverVerdict(result.finalAssistantText)).toBe(ObserverVerdict.Done);
});
