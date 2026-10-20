import { createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { ConversationRunner, RunnerContext, TurnRequest, TurnResult } from "./runners/types";

export type CapturedTurn = {
  result: TurnResult;
  stdoutPath: string;
  stderrPath: string;
  stderrWritten: boolean;
};

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(line);
  stream.write("\n");
}

function promptPathFor(stdoutPath: string): string {
  return stdoutPath
    .replace(/worker\.turn1(?:\.followup)?\.jsonl$/, (name) => (name.includes("followup") ? "prompt.turn1.followup.md" : "prompt.turn1.md"))
    .replace(/worker\.turn2(?:\.followup)?\.jsonl$/, (name) => (name.includes("followup") ? "prompt.turn2.followup.md" : "prompt.turn2.md"))
    .replace(/\.raw\.(jsonl|log)$/, ".prompt.md")
    .replace(/\.jsonl$/, ".prompt.md")
    .replace(/\.log$/, ".prompt.md");
}

export type RunCapturedTurnParams = {
  runner: ConversationRunner;
  request: TurnRequest;
  context: Omit<RunnerContext, "onStdoutLine" | "onStderrLine">;
  stdoutPath: string;
  stderrPath: string;
  resume?: boolean;
};

type ExecuteTurnParams = {
  runner: ConversationRunner;
  request: TurnRequest;
  context: RunnerContext;
  resume: boolean;
};

async function executeTurn(params: ExecuteTurnParams): Promise<TurnResult> {
  const { runner, request, context, resume } = params;
  const { conversationRef } = request;
  if (resume && conversationRef) {
    return runner.resumeTurn({ ...request, conversationRef }, context);
  }
  return runner.startTurn(request, context);
}

export async function runCapturedTurn(params: RunCapturedTurnParams): Promise<CapturedTurn> {
  const { runner, request, context, stdoutPath, stderrPath, resume = false } = params;
  await mkdir(dirname(stdoutPath), { recursive: true });
  const promptFilePath = promptPathFor(stdoutPath);
  await writeFile(promptFilePath, request.prompt, "utf8");
  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });
  let stderrWritten = false;

  const capturedContext: RunnerContext = {
    ...context,
    promptFilePath,
    onStdoutLine: (line) => writeLine(stdoutStream, line),
    onStderrLine: (line) => {
      stderrWritten = true;
      writeLine(stderrStream, line);
    },
  };

  try {
    const result = await executeTurn({ runner, request, context: capturedContext, resume });
    return { result, stdoutPath, stderrPath, stderrWritten };
  } finally {
    await new Promise<void>((resolve) => stdoutStream.end(resolve));
    await new Promise<void>((resolve) => stderrStream.end(resolve));
    if (!stderrWritten && existsSync(stderrPath) && statSync(stderrPath).size === 0) {
      unlinkSync(stderrPath);
    }
  }
}
