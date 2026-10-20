import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runCapturedTurn } from "./capture";
import { parseDisputeResponsesMarkdown, validateDisputeResponse } from "./dispute/protocol";
import { buildObserverPrompt } from "./prompt";
import { iterDir, safeModelName } from "./paths";
import { LoopStatus, updateState, type ObserverRecord } from "./state";
import { backoffMs, makeAbortContext, makeRunnerContext, sleep, timeoutMs } from "./run-helpers";
import { getRunner, type RunnerRegistry } from "./runners/registry";
import { parseObserverVerdict } from "./runners/sentinels";
import {
  AgentRole,
  ObserverVerdict,
  RunnerOutputFormat,
  TurnKind,
  TurnOutcome,
  WorkerSignal,
  type ModelRef,
  type RunnerContext,
  type TurnRequest,
} from "./runners/types";

const DEFAULT_OBSERVER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OBSERVER_RETRY_WINDOW_MS = 5 * 60 * 1000;
const MAX_OBSERVER_ATTEMPTS = 3;

export async function runObservers(
  registry: RunnerRegistry,
  input: {
    loopDir: string;
    workspaceDir: string;
    iter: number;
    task: string;
    stopCondition: string;
    workerSignal: WorkerSignal;
    observers: ModelRef[];
    issueContext?: string;
    onStateChange?: () => Promise<void>;
  },
): Promise<ObserverRecord[]> {
  await updateState(input.loopDir, { status: LoopStatus.ObserversRunning, currentActor: "observers" });
  await input.onStateChange?.();
  return Promise.all(
    input.observers.map((observer, index) => runOneObserver({ registry, input, observer, index })),
  );
}

type RunOneObserverParams = {
  registry: RunnerRegistry;
  input: {
    loopDir: string;
    workspaceDir: string;
    iter: number;
    task: string;
    stopCondition: string;
    workerSignal: WorkerSignal;
    issueContext?: string;
    onStateChange?: () => Promise<void>;
  };
  observer: ModelRef;
  index: number;
};

async function runOneObserver(params: RunOneObserverParams): Promise<ObserverRecord> {
  const { registry, input, observer, index } = params;
  const dir = iterDir(input.loopDir, input.iter);
  const modelName = safeModelName(observer.model);
  const id = `observer-iter-${input.iter}-${index}-${modelName}`;
  const markdownPath = path.join(dir, `${id}.md`);
  const runner = getRunner(registry, observer.provider);
  const rawPath = path.join(dir, `${id}.${runner.outputFormat === RunnerOutputFormat.StreamJson ? "raw.jsonl" : "raw.log"}`);
  const stderrPath = path.join(dir, `${id}.stderr.log`);
  const prompt = await buildObserverPrompt(input);
  const request: TurnRequest = {
    role: AgentRole.Observer,
    kind: TurnKind.Observe,
    model: observer,
    prompt: prompt.replace("observer-iter-<idx>-<model>.md", `${id}.md`),
    timeoutMs: timeoutMs("LOOPERLOOP_OBSERVER_TIMEOUT_MS", DEFAULT_OBSERVER_TIMEOUT_MS),
    permissions: { skip: true },
  };
  const retryWindowMs = timeoutMs("LOOPERLOOP_OBSERVER_RETRY_WINDOW_MS", DEFAULT_OBSERVER_RETRY_WINDOW_MS);

  let lastError: string | undefined;
  let lastText = "";
  for (let attempt = 0; attempt < MAX_OBSERVER_ATTEMPTS; attempt += 1) {
    const abort = makeAbortContext(input.loopDir);
    const startedAt = Date.now();
    const captured = await runCapturedTurn({
      runner,
      request,
      context: makeRunnerContext({
        loopDir: input.loopDir,
        workspaceDir: input.workspaceDir,
        abortSignal: abort.controller.signal,
      }),
      stdoutPath: rawPath,
      stderrPath,
      resume: false,
    }).finally(abort.stop);
    const elapsedMs = Date.now() - startedAt;
    lastText = captured.result.finalAssistantText;
    lastError = captured.result.error;
    if (captured.result.outcome === TurnOutcome.Completed) {
      const verdict = parseObserverVerdict(captured.result.finalAssistantText);
      const disputeResponses = parseDisputeResponsesMarkdown(captured.result.finalAssistantText)
        .map(validateDisputeResponse)
        .map((result) => result.value);
      await writeFile(markdownPath, captured.result.finalAssistantText || "Observer returned no review text.\n", "utf8");
      return {
        id,
        verdict,
        markdownPath,
        rawPath,
        stderrPath: captured.stderrWritten ? stderrPath : undefined,
        error: verdict === ObserverVerdict.Failed ? "missing or invalid observer verdict" : undefined,
        disputeResponses,
      };
    }
    if (attempt < MAX_OBSERVER_ATTEMPTS - 1 && elapsedMs <= retryWindowMs) {
      await sleep(backoffMs(attempt));
    } else {
      break;
    }
  }

  await writeFile(markdownPath, lastText || `Observer failed: ${lastError ?? "unknown error"}\n`, "utf8");
  return {
    id,
    verdict: ObserverVerdict.Failed,
    markdownPath,
    rawPath,
    stderrPath,
    error: lastError ?? "observer failed after retries",
  };
}

export function mergeObserverVerdicts(observers: ObserverRecord[]): ObserverVerdict {
  const usable = observers.filter((observer) => observer.verdict !== ObserverVerdict.Failed);
  if (usable.length === 0) {
    return ObserverVerdict.Continue;
  }
  if (usable.some((observer) => observer.verdict === ObserverVerdict.Abort)) {
    return ObserverVerdict.Abort;
  }
  if (usable.every((observer) => observer.verdict === ObserverVerdict.Done)) {
    return ObserverVerdict.Done;
  }
  return ObserverVerdict.Continue;
}
