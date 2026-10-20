import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnOutcome, type RunnerContext } from "./types";
import { terminateProcessTree } from "../platform";

export type ProcessRun = {
  outcome: TurnOutcome;
  exitCode?: number;
  stdoutLines: string[];
  stderrLines: string[];
  error?: string;
};

export type LocalCommand = {
  command: string;
  prefixArgs?: string[];
};

type CollectLinesParams = {
  stream: ReadableStream<Uint8Array> | null;
  onLine: ((line: string) => void) | undefined;
  lines: string[];
};

async function collectLines(params: CollectLinesParams): Promise<void> {
  const { stream, onLine, lines } = params;
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        onLine?.(line);
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) {
      lines.push(pending);
      onLine?.(pending);
    }
  } finally {
    reader.releaseLock();
  }
}

function resolveCommand(command: string): string {
  if (os.platform() !== "win32") {
    return command;
  }
  if (command.includes("\\") || command.includes("/") || path.extname(command)) {
    return command;
  }
  const pathEntries = (process.env.Path ?? process.env.PATH ?? "").split(";");
  const extensions = [".exe", ".cmd", ".bat", ""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

export type RunLocalCommandParams = {
  command: LocalCommand;
  args: string[];
  context: RunnerContext;
  timeoutMs: number;
  stdinText?: string;
};

export async function runLocalCommand(params: RunLocalCommandParams): Promise<ProcessRun> {
  const { command, args, context, timeoutMs, stdinText } = params;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const cmd = [resolveCommand(command.command), ...(command.prefixArgs ?? []), ...args];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: context.workspaceDir,
      env: { ...process.env, ...(context.env ?? {}) },
      stdin: stdinText === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    return {
      outcome: TurnOutcome.Failed,
      stdoutLines,
      stderrLines,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (proc.pid) {
    context.onProcessStart?.(proc.pid);
  }
  if (stdinText !== undefined) {
    const stdin = proc.stdin as unknown as { write: (chunk: Uint8Array | string) => unknown; end: () => unknown };
    stdin.write(new TextEncoder().encode(stdinText));
    stdin.end();
  }

  async function kill(): Promise<void> {
    if (proc.pid) {
      await terminateProcessTree({ pid: proc.pid, graceMs: 1000 });
      return;
    }
    try {
      proc.kill();
    } catch {
      // Process already exited; nothing to kill.
    }
  }

  async function settleStreams(promises: Promise<void>[], graceMs: number): Promise<void> {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    const streamPromises = [
      collectLines({
        stream: proc.stdout as ReadableStream<Uint8Array> | null,
        onLine: context.onStdoutLine,
        lines: stdoutLines,
      }),
      collectLines({
        stream: proc.stderr as ReadableStream<Uint8Array> | null,
        onLine: context.onStderrLine,
        lines: stderrLines,
      }),
    ];
    const forcedFinish = new Promise<"timeout" | "abort">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      abortHandler = () => resolve("abort");
      context.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    });

    const outcome = await Promise.race([
      proc.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      forcedFinish.then((reason) => ({ kind: reason })),
    ]);

    if (outcome.kind !== "exit") {
      await kill();
      await settleStreams(streamPromises, 2000);
      return {
        outcome: TurnOutcome.TimedOut,
        stdoutLines,
        stderrLines,
        error: outcome.kind === "abort" ? "Process aborted" : `Process timed out after ${timeoutMs}ms`,
      };
    }

    const exitCode = outcome.exitCode;
    await settleStreams(streamPromises, 2000);
    if (exitCode !== 0) {
      return {
        outcome: TurnOutcome.Failed,
        exitCode,
        stdoutLines,
        stderrLines,
        error: `Process exited with code ${exitCode}`,
      };
    }
    return { outcome: TurnOutcome.Completed, exitCode, stdoutLines, stderrLines };
  } catch (error) {
    return {
      outcome: TurnOutcome.Failed,
      stdoutLines,
      stderrLines,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (abortHandler) {
      context.abortSignal?.removeEventListener("abort", abortHandler);
    }
    context.onProcessExit?.();
  }
}
