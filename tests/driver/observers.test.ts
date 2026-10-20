import { afterEach, describe, expect, test } from "bun:test";
import { runObservers } from "../../driver/observers";
import { LoopStatus, writeState } from "../../driver/state";
import { AgentProvider, ObserverVerdict, ReasoningEffort, WorkerSignal } from "../../driver/runners/types";
import { mockRegistry, tempWorkspace } from "./helpers";

const originalObserverTimeout = process.env.LOOPERLOOP_OBSERVER_TIMEOUT_MS;
const originalRetryWindow = process.env.LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS;

afterEach(() => {
  if (originalObserverTimeout === undefined) {
    delete process.env.LOOPERLOOP_OBSERVER_TIMEOUT_MS;
  } else {
    process.env.LOOPERLOOP_OBSERVER_TIMEOUT_MS = originalObserverTimeout;
  }
  if (originalRetryWindow === undefined) {
    delete process.env.LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS;
  } else {
    process.env.LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS = originalRetryWindow;
  }
});

async function writeTestState(loopDir: string): Promise<void> {
  await writeState(loopDir, {
    loopId: "loop-test",
    workspaceDir: loopDir,
    iter: 1,
    maxIter: 3,
    status: LoopStatus.Starting,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    warnings: [],
  });
}

function observerInput(loopDir: string) {
  return {
    loopDir,
    workspaceDir: loopDir,
    iter: 1,
    task: "test task",
    stopCondition: "test stop condition",
    workerSignal: WorkerSignal.None,
    observers: [{ provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.High }],
  };
}

describe("runObservers retry policy", () => {
  test("defaults observer turns to a 30 minute timeout", async () => {
    delete process.env.LOOPERLOOP_OBSERVER_TIMEOUT_MS;
    const loopDir = await tempWorkspace();
    await writeTestState(loopDir);
    let timeoutMs: number | undefined;

    const observers = await runObservers(mockRegistry({
      onStartTurn: (request) => {
        timeoutMs = request.timeoutMs;
      },
    }), observerInput(loopDir));

    expect(observers[0]?.verdict).toBe(ObserverVerdict.Continue);
    expect(timeoutMs).toBe(30 * 60 * 1000);
  });

  test("retries observer failures that happen inside the retry window", async () => {
    process.env.LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS = "50";
    const loopDir = await tempWorkspace();
    await writeTestState(loopDir);
    let attempts = 0;

    const observers = await runObservers(mockRegistry({
      failObservers: true,
      onStartTurn: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    }), observerInput(loopDir));

    expect(attempts).toBe(3);
    expect(observers[0]?.verdict).toBe(ObserverVerdict.Failed);
  });

  test("does not retry observer failures after the retry window has elapsed", async () => {
    process.env.LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS = "10";
    const loopDir = await tempWorkspace();
    await writeTestState(loopDir);
    let attempts = 0;

    const observers = await runObservers(mockRegistry({
      failObservers: true,
      onStartTurn: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    }), observerInput(loopDir));

    expect(attempts).toBe(1);
    expect(observers[0]?.verdict).toBe(ObserverVerdict.Failed);
  });
});
