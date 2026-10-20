import { isStopRequested, updateState } from "./state";
import type { RunnerContext } from "./runners/types";

const RETRY_DELAYS_MS = [5000, 15000, 45000];

export function backoffMs(attempt: number): number {
  if (process.env.LOOPERLOOP_FAST_RETRY === "1") {
    return 1;
  }
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function timeoutMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type AbortContext = { controller: AbortController; stop: () => void };

export function makeAbortContext(loopDir: string): AbortContext {
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (isStopRequested(loopDir)) {
      controller.abort();
    }
  }, 250);
  return {
    controller,
    stop: () => clearInterval(timer),
  };
}

export type RunnerContextParams = {
  loopDir: string;
  workspaceDir: string;
  abortSignal: AbortSignal;
};

export function makeRunnerContext(params: RunnerContextParams): RunnerContext {
  const { loopDir, workspaceDir, abortSignal } = params;
  return {
    workspaceDir,
    abortSignal,
    onProcessStart: (pid) => void updateState(loopDir, { activeChildPid: pid }),
    onProcessExit: () => void updateState(loopDir, { activeChildPid: undefined }),
  };
}
