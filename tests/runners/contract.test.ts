import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createClaudeRunner } from "../../driver/runners/claude-cli";
import { createCodexRunner } from "../../driver/runners/codex-cli";
import {
  AgentProvider,
  AgentRole,
  ClaudeConversationRef,
  CodexConversationRef,
  TurnKind,
  TurnOutcome,
  type ConversationRunner,
} from "../../driver/runners/types";

const root = path.resolve(import.meta.dir, "../..");
const mockClaude = path.join(root, "tests", "fixtures", "mock-claude-cli.ts");
const mockCodex = path.join(root, "tests", "fixtures", "mock-codex-cli.ts");

type RunnerContractParams = {
  name: string;
  provider: AgentProvider;
  runner: ConversationRunner;
};

function describeRunnerContract({ name, provider, runner }: RunnerContractParams) {
  describe(name, () => {
    test("startTurn returns finalAssistantText and streams callbacks", async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await runner.startTurn(
        {
          role: AgentRole.Observer,
          kind: TurnKind.Observe,
          model: { provider, model: "mock" },
          prompt: "hello",
          timeoutMs: 1000,
          permissions: { skip: true },
        },
        {
          workspaceDir: root,
          env: { MOCK_AGENT_SCENARIO: "stderr" },
          onStdoutLine: (line) => stdout.push(line),
          onStderrLine: (line) => stderr.push(line),
        },
      );
      expect(result.outcome).toBe(TurnOutcome.Completed);
      expect(result.finalAssistantText.length).toBeGreaterThan(0);
      expect(stdout.length).toBeGreaterThan(0);
      expect(stderr.length).toBeGreaterThan(0);
    });

    test("rejects unsupported or foreign resume", async () => {
      const foreign =
        provider === AgentProvider.ClaudeCli ? new CodexConversationRef("codex") : new ClaudeConversationRef("claude");
      await expect(
        runner.resumeTurn(
          {
            role: AgentRole.Worker,
            kind: TurnKind.Log,
            model: { provider, model: "mock" },
            prompt: "resume",
            timeoutMs: 1000,
            conversationRef: foreign as never,
          },
          { workspaceDir: root },
        ),
      ).rejects.toThrow(runner.supportsResume ? "provider mismatch" : "does not support resume");
    });

    test("timeout preserves partial stdout and returns TimedOut", async () => {
      const stdout: string[] = [];
      const result = await runner.startTurn(
        {
          role: AgentRole.Observer,
          kind: TurnKind.Observe,
          model: { provider, model: "mock" },
          prompt: "hang",
          timeoutMs: 50,
        },
        {
          workspaceDir: root,
          env: { MOCK_AGENT_SCENARIO: "hang" },
          onStdoutLine: (line) => stdout.push(line),
        },
      );
      expect(result.outcome).toBe(TurnOutcome.TimedOut);
      expect(stdout.join("\n")).toContain("partial output");
    });
  });
}

describeRunnerContract({
  name: "claude-cli",
  provider: AgentProvider.ClaudeCli,
  runner: createClaudeRunner({ command: "bun", prefixArgs: [mockClaude] }),
});

describeRunnerContract({
  name: "codex-cli",
  provider: AgentProvider.CodexCli,
  runner: createCodexRunner({ command: "bun", prefixArgs: [mockCodex] }),
});
