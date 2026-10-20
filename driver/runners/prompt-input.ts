import type { RunnerContext, TurnRequest } from "./types";

export function buildPromptInput(request: TurnRequest, context: RunnerContext): string {
  if (!context.promptFilePath) {
    return request.prompt;
  }
  return `The complete task prompt for this turn is persisted at:
${context.promptFilePath}

Follow the prompt content below exactly.

${request.prompt}`;
}
