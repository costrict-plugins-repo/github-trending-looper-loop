import { expect, test } from "bun:test";
import { buildPromptInput } from "../../driver/runners/prompt-input";
import { AgentProvider, AgentRole, TurnKind } from "../../driver/runners/types";

const request = {
  role: AgentRole.Worker,
  kind: TurnKind.Work,
  model: { provider: AgentProvider.ClaudeCli, model: "opus" },
  prompt: "do the work",
  timeoutMs: 1000,
};

test("prompt input is unchanged without prompt file path", () => {
  expect(buildPromptInput(request, { workspaceDir: "F:\\workspace" })).toBe("do the work");
});

test("prompt input includes shared file-backed prompt preface", () => {
  const input = buildPromptInput(request, { workspaceDir: "F:\\workspace", promptFilePath: "F:\\loop\\prompt.turn1.md" });
  expect(input).toContain("The complete task prompt for this turn is persisted at:");
  expect(input).toContain("F:\\loop\\prompt.turn1.md");
  expect(input).toContain("do the work");
});
