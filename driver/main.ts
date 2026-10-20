import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { startStatusServer } from "./http";
import { createLoopId } from "./ids";
import { notifyCompletion, notifyLoopStarted, writeCompletion } from "./notify";
import { runObservers, mergeObserverVerdicts } from "./observers";
import { openStatusWindow } from "./platform";
import { ensureDir, iterDir, loopDir } from "./paths";
import { runWorkerIteration } from "./worker";
import { extractLooperloopSummary } from "./activity-summary";
import { runIssueBranch } from "./dispute/analysis";
import { IssueState } from "./dispute/machine";
import { ProposedResolution, parseDisputesMarkdown, type Dispute, type DisputeResponse } from "./dispute/protocol";
import { IssueSource, cancelIssues, cancelOpenIssues, createIssue, findIssueByFlag, type IssueRecord } from "./dispute/store";
import { createDefaultRunnerRegistry, type RunnerRegistry } from "./runners/registry";
import {
  AgentProvider,
  FinalDecision,
  ObserverVerdict,
  ReasoningEffort,
  WorkerSignal,
  type ModelRef,
} from "./runners/types";
import {
  LoopStatus,
  NotifyKind,
  ActivityStage,
  ActivityStatus,
  appendActivity,
  configPath,
  defaultObservers,
  defaultWorker,
  globalStatePath,
  isStopRequested,
  readState,
  updateState,
  writeJson,
  writeState,
  type LoopConfig,
  type LoopState,
  type Verdicts,
} from "./state";

export type RunLoopOptions = Omit<LoopConfig, "loopId"> & {
  loopId?: string;
  registry?: RunnerRegistry;
  openStatus?: boolean;
  openStatusWindow?: boolean;
  statusGraceMs?: number;
};

const DEFAULT_STATUS_GRACE_MS = 5 * 60 * 1000;

function parseProvider(value: string): AgentProvider {
  for (const provider of Object.values(AgentProvider)) {
    if (provider === value) {
      return provider;
    }
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function parseEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }
  for (const effort of Object.values(ReasoningEffort)) {
    if (effort === value) {
      return effort;
    }
  }
  return undefined;
}

function normalizeModelRef(model: ModelRef): ModelRef {
  return { ...model, effort: model.effort ?? ReasoningEffort.High };
}

export function parseModelRef(value: string): ModelRef {
  const [provider, ...modelParts] = value.split(":");
  if (!provider || modelParts.length === 0) {
    throw new Error(`Model must look like provider:model, got ${value}`);
  }
  const effort = parseEffort(modelParts.at(-1));
  const model = effort ? modelParts.slice(0, -1).join(":") : modelParts.join(":");
  if (!model) {
    throw new Error(`Model must look like provider:model, got ${value}`);
  }
  return normalizeModelRef({ provider: parseProvider(provider), model, effort });
}

type DecideParams = {
  workerSignal: WorkerSignal;
  merged: ObserverVerdict;
  maxIterReached: boolean;
  stop: boolean;
  hasBlockingIssue?: boolean;
};

function decide(params: DecideParams): FinalDecision {
  const { workerSignal, merged, maxIterReached, stop, hasBlockingIssue } = params;
  if (stop || maxIterReached) {
    return FinalDecision.Abort;
  }
  if (workerSignal === WorkerSignal.Abort || merged === ObserverVerdict.Abort) {
    return FinalDecision.Abort;
  }
  if (hasBlockingIssue) {
    return FinalDecision.NeedsUser;
  }
  if (workerSignal === WorkerSignal.Done && merged === ObserverVerdict.Done) {
    return FinalDecision.Done;
  }
  return FinalDecision.Continue;
}

function statusGraceMs(optionValue: number | undefined): number {
  if (optionValue !== undefined) {
    return Math.max(0, optionValue);
  }
  const raw = process.env.LOOPERLOOP_STATUS_GRACE_MS;
  if (!raw) {
    return DEFAULT_STATUS_GRACE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STATUS_GRACE_MS;
}

type SummaryForTerminalParams = {
  status: LoopStatus;
  iter: number;
  maxIter: number;
};

function summaryForTerminal({ status, iter, maxIter }: SummaryForTerminalParams): string {
  if (status === LoopStatus.Done) {
    return `Done in ${iter} of ${maxIter} iterations.`;
  }
  if (status === LoopStatus.MaxIterReached) {
    return `Max iterations reached at ${iter} of ${maxIter}.`;
  }
  if (status === LoopStatus.Cancelled) {
    return `Cancelled at iteration ${iter} of ${maxIter}.`;
  }
  if (status === LoopStatus.Aborted) {
    return `Aborted at iteration ${iter} of ${maxIter}.`;
  }
  if (status === LoopStatus.NeedsUser) {
    return `Needs user decision at iteration ${iter} of ${maxIter}.`;
  }
  if (status === LoopStatus.Failed) {
    return `Failed at iteration ${iter} of ${maxIter}.`;
  }
  return `${status} at iteration ${iter} of ${maxIter}.`;
}

type WorkerActivitySummaryParams = {
  signal: WorkerSignal;
  failed: boolean;
  error?: string;
};

function workerActivitySummary({ signal, failed, error }: WorkerActivitySummaryParams): string {
  if (failed) {
    return error ?? "The worker could not finish this iteration.";
  }
  if (signal === WorkerSignal.Done) {
    return "The worker says the goal is complete and wrote its notes.";
  }
  if (signal === WorkerSignal.Abort) {
    return "The worker stopped itself and wrote the reason in its notes.";
  }
  return "The worker finished this iteration and wrote notes. The goal is not marked complete yet.";
}

function observerActivitySummary(verdict: ObserverVerdict, error?: string): string {
  if (error) {
    return error;
  }
  if (verdict === ObserverVerdict.Done) {
    return "The reviewer agrees the goal is complete.";
  }
  if (verdict === ObserverVerdict.Continue) {
    return "The reviewer thinks another iteration is needed.";
  }
  if (verdict === ObserverVerdict.Abort) {
    return "The reviewer found a reason to stop the loop.";
  }
  return "The reviewer did not return a usable verdict.";
}

function decisionTitle(final: FinalDecision): string {
  if (final === FinalDecision.Done) {
    return "Decision: done";
  }
  if (final === FinalDecision.Abort) {
    return "Decision: stop";
  }
  if (final === FinalDecision.NeedsUser) {
    return "Decision: needs user";
  }
  return "Decision: continue";
}

function decisionSummary(workerSignal: WorkerSignal, merged: ObserverVerdict, blockingIssue?: IssueRecord): string {
  if (blockingIssue) {
    return blockingIssue.synthesis?.userQuestion ?? blockingIssue.synthesis?.blockReason ?? "A side issue needs a user decision.";
  }
  if (workerSignal === WorkerSignal.Done && merged === ObserverVerdict.Done) {
    return "The worker and reviewer agree the goal is complete.";
  }
  if (merged === ObserverVerdict.Abort || workerSignal === WorkerSignal.Abort) {
    return "The loop will stop because the worker or reviewer requested it.";
  }
  if (workerSignal === WorkerSignal.Done && merged === ObserverVerdict.Continue) {
    return "The worker claimed completion, but the reviewer asked for another iteration.";
  }
  if (merged === ObserverVerdict.Done) {
    return "The reviewer thinks the goal is complete; the next worker turn will verify and finalize.";
  }
  return "The loop will continue with another worker iteration.";
}

function reviewerTitle(model: ModelRef, index: number): string {
  return index === 0 ? `${model.model} reviewer finished` : `${model.model} reviewer ${index + 1} finished`;
}

type PendingIssueBranch = {
  issueId: string;
  controller: AbortController;
  promise: Promise<IssueRecord>;
};

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function fallbackDispute(iter: number, response: DisputeResponse): Dispute {
  return {
    flag: response.flag,
    raisedInIter: iter,
    workerPosition: response.observerPosition,
    proposedResolution: ProposedResolution.NeedsUserDecision,
    evidence: [response.reason],
  };
}

function issueContext(issues: IssueRecord[]): string {
  return issues.map((issue) => {
    const synthesis = issue.synthesis;
    const responses = issue.responses.length
      ? issue.responses.map((response, index) => `  response_${index + 1}:
    observer_position: ${response.observerPosition}
    escalate: ${response.escalate}
    blocking_requested: ${response.blocking}
    reason: ${response.reason}
    block_reason: ${response.blockReason ?? ""}
    recommended_resolution: ${response.recommendedResolution}`).join("\n")
      : "  responses: none";
    const analyses = issue.files.analyses.length
      ? issue.files.analyses.map((file) => `    - ${file}`).join("\n")
      : "    - none";
    return `- ${issue.id}: ${issue.flag}
  state: ${issue.state}
  reason: ${synthesis?.reason ?? "No synthesis reason."}
  block_reason: ${synthesis?.blockReason ?? ""}
  user_question: ${synthesis?.userQuestion ?? ""}
  worker_instruction: ${synthesis?.recommendedInstructionForWorker ?? ""}
  files:
    issue: ${issue.files.issue}
    synthesis: ${issue.files.synthesis ?? ""}
    synthesis_json: ${issue.files.synthesisJson ?? ""}
    analyses:
${analyses}
${responses}`;
  }).join("\n");
}

export async function runLoop(options: RunLoopOptions): Promise<LoopState> {
  const loopId = options.loopId ?? createLoopId(options.workspaceDir);
  const root = loopDir(options.workspaceDir, loopId);
  const registry = options.registry ?? createDefaultRunnerRegistry();
  await ensureDir(root);
  const config: LoopConfig = {
    loopId,
    workspaceDir: options.workspaceDir,
    task: options.task,
    maxIter: options.maxIter,
    worker: normalizeModelRef(options.worker),
    observers: options.observers.map(normalizeModelRef),
    stopCondition: options.stopCondition,
    notify: options.notify,
  };
  await writeJson(configPath(root), config);
  if (!existsSync(globalStatePath(root))) {
    await writeFile(globalStatePath(root), `# Global State\n\nGoal: ${options.task}\n\nNothing has been completed yet.\n`, "utf8");
  }
  const startedAt = new Date().toISOString();
  await writeState(root, {
    loopId,
    workspaceDir: options.workspaceDir,
    iter: 0,
    maxIter: options.maxIter,
    status: LoopStatus.Starting,
    startedAt,
    updatedAt: startedAt,
    platform: os.platform(),
    pid: process.pid,
    warnings: [],
    activity: [],
  });

  const server = options.openStatus === false ? undefined : await startStatusServer(root);
  if (server) {
    const state = await updateState(root, { statusUrl: server.url });
    if (options.openStatusWindow !== false) {
      await openStatusWindow(server.url, { width: 420, height: 640 });
    }
    await notifySafely(() => notifyLoopStarted({ loopId, state, config }));
  } else {
    const state = await readState(root);
    await notifySafely(() => notifyLoopStarted({ loopId, state, config }));
  }
  const broadcast = async () => {
    await server?.broadcast();
  };
  const updateAndBroadcast = async (patch: Parameters<typeof updateState>[1]) => {
    const state = await updateState(root, patch);
    await broadcast();
    return state;
  };
  const completeAndBroadcast = async (
    patch: Partial<LoopState>,
    outcome: string,
    reason?: string,
  ) => {
    const current = await readState(root);
    const state: LoopState = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeCompletion(root, { loopId, outcome, reason, completedAt: new Date().toISOString(), state, config });
    await writeState(root, state);
    await broadcast();
    if (config.notify.length) {
      await notifySafely(() => notifyCompletion({ loopId, outcome, reason, completedAt: new Date().toISOString(), state, config }));
    }
    return state;
  };
  const appendActivityAndBroadcast = async (entry: Parameters<typeof appendActivity>[1]) => {
    const state = await appendActivity(root, entry);
    await broadcast();
    return state;
  };
  const cancelPendingIssueBranches = async () => {
    for (const branch of pendingIssueBranches) {
      branch.controller.abort();
    }
    await cancelOpenIssues(root, { onMutate: broadcast });
    if (pendingIssueBranches.length) {
      await Promise.allSettled(pendingIssueBranches.map((branch) => branch.promise));
      pendingIssueBranches = [];
      await cancelOpenIssues(root, { onMutate: broadcast });
    }
  };

  let lastIter = 0;
  let pendingIssueBranches: PendingIssueBranch[] = [];
  const unEscalatedDisputeCounts = new Map<string, { count: number; lastIter: number; response: DisputeResponse }>();
  const openedDisputeFlags = new Set<string>();
  try {
    for (let iter = 1; iter <= options.maxIter; iter += 1) {
      lastIter = iter;
      await mkdir(iterDir(root, iter), { recursive: true });
      if (isStopRequested(root)) {
        break;
      }
      const worker = await runWorkerIteration(registry, {
        loopDir: root,
        workspaceDir: options.workspaceDir,
        iter,
        maxIter: options.maxIter,
        task: options.task,
        worker: config.worker,
        onStateChange: broadcast,
      });
      const workerLogPath = path.join(iterDir(root, iter), "worker.log.md");
      const workerLogSummary = extractLooperloopSummary(await readOptional(workerLogPath));
      await appendActivityAndBroadcast({
        iter,
        stage: ActivityStage.WorkerLog,
        status: worker.failed ? ActivityStatus.Failed : ActivityStatus.Done,
        title: worker.failed ? "Worker had a problem" : "Worker finished this iteration",
        summary: workerLogSummary ?? workerActivitySummary({ signal: worker.signal, failed: worker.failed ?? false, error: worker.error }),
        file: workerLogPath,
        verdict: worker.signal,
        model: config.worker,
      });
      await broadcast();
      if (isStopRequested(root)) {
        break;
      }

      if (worker.failed) {
        const final = decide({
          workerSignal: worker.signal,
          merged: ObserverVerdict.Failed,
          maxIterReached: iter >= options.maxIter,
          stop: isStopRequested(root),
        });
        await writeJson(path.join(iterDir(root, iter), "verdicts.json"), {
          worker: worker.signal,
          workerAbortReason: worker.abortReason,
          observers: [],
          merged: ObserverVerdict.Failed,
          final,
        } satisfies Verdicts);
        const state = await updateState(root, {
          iter,
          status: LoopStatus.Deciding,
          currentActor: "driver",
          lastVerdict: final,
          warnings: [worker.error ?? "Worker failed before observers could run."],
        });
        await broadcast();
        await appendActivityAndBroadcast({
          iter,
          stage: ActivityStage.Decision,
          status: ActivityStatus.Failed,
          title: decisionTitle(final),
          summary: worker.error ?? "Worker failed before observers could run.",
          file: path.join(iterDir(root, iter), "verdicts.json"),
          verdict: final,
        });
        if (iter >= options.maxIter) {
          await cancelPendingIssueBranches();
          return completeAndBroadcast({
            status: LoopStatus.MaxIterReached,
            currentActor: undefined,
            lastVerdict: "max-iter-reached",
            resultSummary: summaryForTerminal({ status: LoopStatus.MaxIterReached, iter, maxIter: options.maxIter }),
          }, "max-iter-reached");
        }
        continue;
      }

      let completedIssueBranches: IssueRecord[] = [];
      if (pendingIssueBranches.length && iter >= options.maxIter) {
        await cancelPendingIssueBranches();
      } else if (pendingIssueBranches.length) {
        const pendingIssueIds = pendingIssueBranches.map((branch) => branch.issueId);
        completedIssueBranches = await Promise.all(pendingIssueBranches.map((branch) => branch.promise));
        pendingIssueBranches = [];
        if (isStopRequested(root)) {
          await cancelIssues(root, pendingIssueIds, true, { onMutate: broadcast });
          break;
        }
      }
      for (const issue of completedIssueBranches) {
        const issueFailed = issue.state === IssueState.Failed;
        await appendActivityAndBroadcast({
          iter,
          stage: ActivityStage.IssueSynthesis,
          status: issueFailed ? ActivityStatus.Failed : ActivityStatus.Done,
          title: issueFailed ? `${issue.flag} issue analysis failed` : `${issue.flag} issue reviewed`,
          summary: issueFailed ? "All side-branch analyzers failed, so no synthesis was produced." : issue.synthesis?.reason ?? "Issue branch completed.",
          file: issue.files.synthesis ?? issue.files.issue,
          verdict: issue.state,
          issueId: issue.id,
        });
      }
      const observers = await runObservers(registry, {
        loopDir: root,
        workspaceDir: options.workspaceDir,
        iter,
        task: options.task,
        stopCondition: options.stopCondition,
        workerSignal: worker.signal,
        observers: config.observers,
        issueContext: issueContext(completedIssueBranches),
        onStateChange: broadcast,
      });
      for (const [index, observer] of observers.entries()) {
        const observerSummary = extractLooperloopSummary(await readOptional(observer.markdownPath));
        await appendActivityAndBroadcast({
          iter,
          stage: ActivityStage.Observer,
          status: observer.verdict === ObserverVerdict.Failed ? ActivityStatus.Failed : ActivityStatus.Done,
          title: reviewerTitle(config.observers[index] ?? config.observers[0], index),
          summary: observerSummary ?? observerActivitySummary(observer.verdict, observer.error),
          file: observer.markdownPath,
          verdict: observer.verdict,
          observerId: observer.id,
          model: config.observers[index] ?? config.observers[0],
        });
      }
      const merged = mergeObserverVerdicts(observers);
      const disputedFlagsText = await readOptional(path.join(iterDir(root, iter), "disputed-flags.md"));
      const disputes = parseDisputesMarkdown(disputedFlagsText);
      const disputesByFlag = new Map(disputes.map((dispute) => [dispute.flag, dispute]));
      const newIssueIds: string[] = [];
      const unEscalatedThisIter = new Map<string, DisputeResponse>();
      const openIssueForResponse = async (response: DisputeResponse, source: IssueSource, observerIndex?: number) => {
        const dispute = disputesByFlag.get(response.flag) ?? fallbackDispute(iter, response);
        if (openedDisputeFlags.has(dispute.flag) || await findIssueByFlag(root, dispute.flag)) {
          return;
        }
        const issue = await createIssue(root, {
          dispute,
          source,
          responses: [response],
          originObserverIndex: source === IssueSource.Observer ? observerIndex : undefined,
        }, { onMutate: broadcast });
        openedDisputeFlags.add(dispute.flag);
        newIssueIds.push(issue.id);
        await appendActivityAndBroadcast({
          iter,
          stage: ActivityStage.IssueOpened,
          status: ActivityStatus.Done,
          title: `${issue.flag} issue opened`,
          summary: response.reason,
          file: issue.files.issue,
          verdict: response.blocking ? "blocking-candidate" : "non-blocking-candidate",
          issueId: issue.id,
        });
        if (iter < options.maxIter) {
          const controller = new AbortController();
          pendingIssueBranches.push({
            issueId: issue.id,
            controller,
            promise: runIssueBranch(registry, {
              loopDir: root,
              workspaceDir: options.workspaceDir,
              task: options.task,
              stopCondition: options.stopCondition,
              worker: config.worker,
              observers: config.observers,
              issueId: issue.id,
              abortSignal: controller.signal,
              onStateChange: broadcast,
            }),
          });
        }
      };
      for (const [observerIndex, observer] of observers.entries()) {
        for (const response of observer.disputeResponses ?? []) {
          if (response.escalate) {
            unEscalatedDisputeCounts.delete(response.flag);
            await openIssueForResponse(response, IssueSource.Observer, observerIndex);
          } else {
            unEscalatedThisIter.set(response.flag, response);
          }
        }
      }
      for (const [flag, response] of unEscalatedThisIter) {
        const previous = unEscalatedDisputeCounts.get(flag);
        const count = previous?.lastIter === iter - 1 ? previous.count + 1 : 1;
        unEscalatedDisputeCounts.set(flag, { count, lastIter: iter, response });
        if (count >= 2) {
          await openIssueForResponse(response, IssueSource.DeadlockDetector);
        }
      }
      let mergedIssues = completedIssueBranches;
      if (iter >= options.maxIter && newIssueIds.length) {
        await cancelOpenIssues(root, { onMutate: broadcast });
      }
      const blockingIssue = mergedIssues.find((issue) => issue.state === IssueState.Blocking);
      let final = decide({
        workerSignal: worker.signal,
        merged,
        maxIterReached: iter >= options.maxIter,
        stop: isStopRequested(root),
        hasBlockingIssue: Boolean(blockingIssue),
      });
      if (!blockingIssue && newIssueIds.length > 0 && iter < options.maxIter && final === FinalDecision.Done) {
        final = FinalDecision.Continue;
      }
      const verdicts: Verdicts = {
        worker: worker.signal,
        workerAbortReason: worker.abortReason,
        observers,
        merged,
        final,
        disputesRaised: newIssueIds,
        disputesMerged: mergedIssues.map((issue) => issue.id),
      };
      await writeJson(path.join(iterDir(root, iter), "verdicts.json"), verdicts);

      const warnings = observers.every((observer) => observer.verdict === ObserverVerdict.Failed)
        ? ["All observers failed; continuing by policy."]
        : [];
      await updateState(root, {
        iter,
        status: LoopStatus.Deciding,
        currentActor: "driver",
        lastVerdict: final,
        warnings,
      });
      await broadcast();
      await appendActivityAndBroadcast({
        iter,
        stage: ActivityStage.Decision,
        status: ActivityStatus.Done,
        title: decisionTitle(final),
        summary: decisionSummary(worker.signal, merged, blockingIssue),
        file: path.join(iterDir(root, iter), "verdicts.json"),
        verdict: final,
      });

      if (final === FinalDecision.NeedsUser) {
        return completeAndBroadcast({
          status: LoopStatus.NeedsUser,
          currentActor: undefined,
          lastVerdict: final,
          resultSummary: summaryForTerminal({ status: LoopStatus.NeedsUser, iter, maxIter: options.maxIter }),
        }, "needs-user", blockingIssue?.synthesis?.blockReason);
      }
      if (final === FinalDecision.Done) {
        return completeAndBroadcast({ status: LoopStatus.Done, currentActor: undefined, lastVerdict: final, resultSummary: summaryForTerminal({ status: LoopStatus.Done, iter, maxIter: options.maxIter }) }, "done");
      }
      if (final === FinalDecision.Abort && iter >= options.maxIter) {
        await cancelPendingIssueBranches();
        return completeAndBroadcast({
          status: LoopStatus.MaxIterReached,
          currentActor: undefined,
          lastVerdict: "max-iter-reached",
          resultSummary: summaryForTerminal({ status: LoopStatus.MaxIterReached, iter, maxIter: options.maxIter }),
        }, "max-iter-reached");
      }
      if (final === FinalDecision.Abort) {
        await cancelPendingIssueBranches();
        if (isStopRequested(root)) {
          return completeAndBroadcast({
            status: LoopStatus.Cancelled,
            currentActor: undefined,
            lastVerdict: "cancelled",
            resultSummary: summaryForTerminal({ status: LoopStatus.Cancelled, iter, maxIter: options.maxIter }),
          }, "cancelled");
        }
        return completeAndBroadcast({
          status: LoopStatus.Aborted,
          currentActor: undefined,
          lastVerdict: final,
          resultSummary: summaryForTerminal({ status: LoopStatus.Aborted, iter, maxIter: options.maxIter }),
        }, "aborted", worker.abortReason);
      }
    }

    const cancelled = isStopRequested(root);
    if (cancelled) {
      await cancelPendingIssueBranches();
    }
    return completeAndBroadcast({
      status: cancelled ? LoopStatus.Cancelled : LoopStatus.MaxIterReached,
      currentActor: undefined,
      lastVerdict: cancelled ? "cancelled" : "max-iter-reached",
      resultSummary: summaryForTerminal({ status: cancelled ? LoopStatus.Cancelled : LoopStatus.MaxIterReached, iter: lastIter, maxIter: options.maxIter }),
    }, cancelled ? "cancelled" : "max-iter-reached");
  } catch (error) {
    return completeAndBroadcast({
      status: LoopStatus.Failed,
      currentActor: undefined,
      warnings: [error instanceof Error ? error.message : String(error)],
      resultSummary: summaryForTerminal({ status: LoopStatus.Failed, iter: lastIter, maxIter: options.maxIter }),
    }, "failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (server) {
      const graceMs = statusGraceMs(options.statusGraceMs);
      if (graceMs > 0) {
        await sleep(graceMs);
      }
      server.close();
    }
  }
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function notifySafely(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.warn(`looperloop notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseNotifyKinds(value: string | undefined): NotifyKind[] {
  if (!value) {
    return [NotifyKind.Sound, NotifyKind.Toast, NotifyKind.Global];
  }
  if (value === "none" || value === "false") {
    return [];
  }
  const supported = new Set(Object.values(NotifyKind));
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!supported.has(item as NotifyKind)) {
        throw new Error(`Unsupported notify kind: ${item}`);
      }
      return item as NotifyKind;
    });
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const workspaceDir = readArg(args, "--workspace") ?? process.cwd();
  const task = readArg(args, "--task");
  const max = Number(readArg(args, "--max") ?? "0");
  if (!task || !Number.isFinite(max) || max <= 0) {
    console.error("Usage: bun run driver/main.ts --workspace <dir> --task <task> --max <n> [--worker provider:model] [--observers provider:model,provider:model]");
    process.exit(2);
  }
  const worker = readArg(args, "--worker") ? parseModelRef(readArg(args, "--worker")!) : defaultWorker();
  const observers = readArg(args, "--observers")
    ? readArg(args, "--observers")!
        .split(",")
        .filter(Boolean)
        .map(parseModelRef)
    : defaultObservers();
  const stopCondition = readArg(args, "--stop-condition") ?? task;
  const loopId = readArg(args, "--loop-id");
  const openStatus = !args.includes("--no-status");
  const notify = parseNotifyKinds(readArg(args, "--notify"));
  const state = await runLoop({
    loopId,
    workspaceDir,
    task,
    maxIter: max,
    worker,
    observers,
    stopCondition,
    notify,
    openStatus,
  });
  console.log(JSON.stringify(state));
}
