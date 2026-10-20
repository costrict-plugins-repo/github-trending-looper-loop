import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runCapturedTurn } from "./capture";
import { buildWorkerLogPrompt, buildWorkerPrompt } from "./prompt";
import { iterDir } from "./paths";
import { LoopStatus, globalStatePath, updateState } from "./state";
import { backoffMs, makeAbortContext, makeRunnerContext, sleep, timeoutMs } from "./run-helpers";
import { getRunner, type RunnerRegistry } from "./runners/registry";
import { parseWorkerSignal } from "./runners/sentinels";
import {
  AgentRole,
  TurnKind,
  TurnOutcome,
  WorkerSignal,
  type ConversationRef,
  type ModelRef,
  type RunnerContext,
  type TurnRequest,
} from "./runners/types";

export type WorkerIterationResult = {
  signal: WorkerSignal;
  abortReason?: string;
  conversationRef?: ConversationRef;
  turn1RawPath: string;
  turn2RawPath: string;
  failed?: boolean;
  error?: string;
};

type RunWithRetriesParams = {
  request: TurnRequest;
  context: RunnerContext;
  registry: RunnerRegistry;
  stdoutPath: string;
  stderrPath: string;
  resume: boolean;
};

async function runWithRetries(
  params: RunWithRetriesParams,
): Promise<{ result: Awaited<ReturnType<typeof runCapturedTurn>>; attempts: number }> {
  const { request, context, registry, stdoutPath, stderrPath, resume } = params;
  const runner = getRunner(registry, request.model.provider);
  if (request.role === AgentRole.Worker && !runner.supportsResume) {
    throw new Error(`Worker runner ${runner.provider} does not support resume`);
  }

  const captureParams = { runner, request, context, stdoutPath, stderrPath, resume };
  let lastResult = await runCapturedTurn(captureParams);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = lastResult.result.outcome;
    if (outcome === TurnOutcome.Completed || outcome === TurnOutcome.TimedOut) {
      return { result: lastResult, attempts: attempt + 1 };
    }
    if (attempt === 2) {
      break;
    }
    await sleep(backoffMs(attempt));
    lastResult = await runCapturedTurn(captureParams);
  }
  return { result: lastResult, attempts: 3 };
}

type EnsureWorkerLogParams = {
  loopDir: string;
  iter: number;
  text: string;
  reason?: string;
};

function workerLogBody(text: string, reason: string | undefined): string {
  if (reason) {
    return `# Worker Log\n\nThe worker log step failed or did not write a log.\n\nReason: ${reason}\n\nLast assistant text:\n\n${text}\n`;
  }
  return `# Worker Log\n\n${text || "The worker did not write a markdown log. See raw worker.turn*.jsonl files for details."}\n`;
}

async function ensureWorkerLog(params: EnsureWorkerLogParams): Promise<void> {
  const { loopDir, iter, text, reason } = params;
  const file = path.join(iterDir(loopDir, iter), "worker.log.md");
  if (existsSync(file)) {
    return;
  }
  await writeFile(file, workerLogBody(text, reason), "utf8");
}

async function ensureGlobalState(loopDir: string, task: string): Promise<void> {
  const file = globalStatePath(loopDir);
  if (existsSync(file)) {
    return;
  }
  await writeFile(file, `# Global State\n\nGoal: ${task}\n\nNo successful worker log has updated global state yet.\n`, "utf8");
}

export async function runWorkerIteration(
  registry: RunnerRegistry,
  input: {
    loopDir: string;
    workspaceDir: string;
    iter: number;
    maxIter: number;
    task: string;
    worker: ModelRef;
    onStateChange?: () => Promise<void>;
  },
): Promise<WorkerIterationResult> {
  const dir = iterDir(input.loopDir, input.iter);
  const prompt1 = await buildWorkerPrompt(input);
  const prompt2 = buildWorkerLogPrompt(input);
  await writeFile(path.join(dir, "prompt.turn1.md"), prompt1, "utf8");
  await writeFile(path.join(dir, "prompt.turn2.md"), prompt2, "utf8");

  const turn1Abort = makeAbortContext(input.loopDir);
  await updateState(input.loopDir, { iter: input.iter, status: LoopStatus.WorkerRunning, currentActor: "worker.turn1" });
  await input.onStateChange?.();
  const turn1Request: TurnRequest = {
    role: AgentRole.Worker,
    kind: TurnKind.Work,
    model: input.worker,
    prompt: prompt1,
    timeoutMs: timeoutMs("LOOPERLOOP_WORK_TIMEOUT_MS", 30 * 60 * 1000),
    permissions: { skip: true },
  };
  const turn1 = await runWithRetries({
    request: turn1Request,
    context: makeRunnerContext({
      loopDir: input.loopDir,
      workspaceDir: input.workspaceDir,
      abortSignal: turn1Abort.controller.signal,
    }),
    registry,
    stdoutPath: path.join(dir, "worker.turn1.jsonl"),
    stderrPath: path.join(dir, "worker.turn1.stderr.log"),
    resume: false,
  }).finally(turn1Abort.stop);

  if (turn1.result.result.outcome === TurnOutcome.TimedOut && turn1.result.result.conversationRef) {
    const followupAbort = makeAbortContext(input.loopDir);
    await runWithRetries({
      request: {
        ...turn1Request,
        prompt: "You hit the 30min budget for this iteration. Wrap up your current work, do not start anything new, and exit cleanly.",
        timeoutMs: timeoutMs("LOOPERLOOP_WORK_FOLLOWUP_TIMEOUT_MS", 10 * 60 * 1000),
        conversationRef: turn1.result.result.conversationRef,
      },
      context: makeRunnerContext({
        loopDir: input.loopDir,
        workspaceDir: input.workspaceDir,
        abortSignal: followupAbort.controller.signal,
      }),
      registry,
      stdoutPath: path.join(dir, "worker.turn1.followup.jsonl"),
      stderrPath: path.join(dir, "worker.turn1.followup.stderr.log"),
      resume: true,
    }).finally(followupAbort.stop);
  }

  const conversationRef = turn1.result.result.conversationRef;
  if (!conversationRef) {
    await ensureWorkerLog({
      loopDir: input.loopDir,
      iter: input.iter,
      text: turn1.result.result.finalAssistantText,
      reason: "worker turn 1 did not produce a resumable conversation ref",
    });
    await ensureGlobalState(input.loopDir, input.task);
    return {
      signal: WorkerSignal.None,
      turn1RawPath: path.join(dir, "worker.turn1.jsonl"),
      turn2RawPath: path.join(dir, "worker.turn2.jsonl"),
      failed: true,
      error: turn1.result.result.error ?? "missing conversation ref",
    };
  }

  const turn2Abort = makeAbortContext(input.loopDir);
  await updateState(input.loopDir, { status: LoopStatus.WorkerLogging, currentActor: "worker.turn2" });
  await input.onStateChange?.();
  const turn2Request: TurnRequest = {
    role: AgentRole.Worker,
    kind: TurnKind.Log,
    model: input.worker,
    prompt: prompt2,
    timeoutMs: timeoutMs("LOOPERLOOP_LOG_TIMEOUT_MS", 15 * 60 * 1000),
    conversationRef,
    permissions: { skip: true },
  };
  const turn2 = await runWithRetries({
    request: turn2Request,
    context: makeRunnerContext({
      loopDir: input.loopDir,
      workspaceDir: input.workspaceDir,
      abortSignal: turn2Abort.controller.signal,
    }),
    registry,
    stdoutPath: path.join(dir, "worker.turn2.jsonl"),
    stderrPath: path.join(dir, "worker.turn2.stderr.log"),
    resume: true,
  }).finally(turn2Abort.stop);

  if (turn2.result.result.outcome === TurnOutcome.TimedOut) {
    const followupAbort = makeAbortContext(input.loopDir);
    await runWithRetries({
      request: {
        ...turn2Request,
        prompt: "You hit the 15min budget for logging. Finish writing worker.log.md and global-state.md, then exit. Do not do new work.",
        timeoutMs: timeoutMs("LOOPERLOOP_LOG_FOLLOWUP_TIMEOUT_MS", 5 * 60 * 1000),
      },
      context: makeRunnerContext({
        loopDir: input.loopDir,
        workspaceDir: input.workspaceDir,
        abortSignal: followupAbort.controller.signal,
      }),
      registry,
      stdoutPath: path.join(dir, "worker.turn2.followup.jsonl"),
      stderrPath: path.join(dir, "worker.turn2.followup.stderr.log"),
      resume: true,
    }).finally(followupAbort.stop);
  }

  await ensureWorkerLog({
    loopDir: input.loopDir,
    iter: input.iter,
    text: turn2.result.result.finalAssistantText,
    reason: turn2.result.result.error,
  });
  await ensureGlobalState(input.loopDir, input.task);
  const parsed = parseWorkerSignal(turn2.result.result.finalAssistantText);
  return {
    signal: parsed.signal,
    abortReason: parsed.reason,
    conversationRef,
    turn1RawPath: path.join(dir, "worker.turn1.jsonl"),
    turn2RawPath: path.join(dir, "worker.turn2.jsonl"),
    error: turn2.result.result.error,
  };
}
