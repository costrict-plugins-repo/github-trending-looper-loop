import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loopDir, loopRoot } from "./paths";
import { type DisputeResponse } from "./dispute/protocol";
import { AgentProvider, FinalDecision, ObserverVerdict, ReasoningEffort, WorkerSignal, type ModelRef } from "./runners/types";

export enum LoopStatus {
  Starting = "starting",
  WorkerRunning = "worker-running",
  WorkerLogging = "worker-logging",
  ObserversRunning = "observers-running",
  AnalyzingDispute = "analyzing-dispute",
  Deciding = "deciding",
  Cancelling = "cancelling",
  Done = "done",
  NeedsUser = "needs-user",
  Aborted = "aborted",
  Cancelled = "cancelled",
  MaxIterReached = "max-iter-reached",
  Failed = "failed",
}

export enum NotifyKind {
  Sound = "sound",
  Toast = "toast",
  Global = "global",
}

export enum ActivityStage {
  WorkerWork = "worker-work",
  WorkerLog = "worker-log",
  Observer = "observer",
  IssueOpened = "issue-opened",
  IssueAnalyzing = "issue-analyzing",
  IssueSynthesis = "issue-synthesis",
  Decision = "decision",
}

export enum ActivityStatus {
  Running = "running",
  Done = "done",
  Failed = "failed",
}

export type LoopConfig = {
  loopId: string;
  workspaceDir: string;
  task: string;
  maxIter: number;
  worker: ModelRef;
  observers: ModelRef[];
  stopCondition: string;
  notify: NotifyKind[];
};

export type LoopState = {
  loopId: string;
  workspaceDir: string;
  iter: number;
  maxIter: number;
  status: LoopStatus;
  currentActor?: string;
  lastVerdict?: string;
  statusUrl?: string;
  startedAt: string;
  updatedAt: string;
  platform?: NodeJS.Platform;
  pid?: number;
  activeChildPid?: number;
  warnings: string[];
  resultSummary?: string;
  activity?: ActivityEntry[];
};

export type ActivityEntry = {
  iter: number;
  stage: ActivityStage;
  status: ActivityStatus;
  title: string;
  summary?: string;
  file?: string;
  verdict?: string;
  startedAt?: string;
  observerId?: string;
  model?: ModelRef;
  issueId?: string;
  analysisName?: string;
  updatedAt: string;
};

export type ObserverRecord = {
  id: string;
  verdict: ObserverVerdict;
  markdownPath: string;
  rawPath: string;
  stderrPath?: string;
  error?: string;
  disputeResponses?: DisputeResponse[];
};

export type Verdicts = {
  worker: WorkerSignal;
  workerAbortReason?: string;
  observers: ObserverRecord[];
  merged: ObserverVerdict;
  final: FinalDecision;
  disputesRaised?: string[];
  disputesMerged?: string[];
};

export function defaultWorker(): ModelRef {
  return { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.High };
}

export function defaultObservers(): ModelRef[] {
  return [{ provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.High }];
}

export function statePath(root: string): string {
  return path.join(root, "state.json");
}

export function configPath(root: string): string {
  return path.join(root, "config.json");
}

export function stopPath(root: string): string {
  return path.join(root, "STOP");
}

export function completePath(root: string): string {
  return path.join(root, "COMPLETE");
}

export function resultPath(root: string): string {
  return path.join(root, "RESULT.json");
}

export function globalStatePath(root: string): string {
  return path.join(root, "global-state.md");
}

export function activityPath(root: string): string {
  return path.join(root, "activity.jsonl");
}

const stateQueues = new Map<string, Promise<unknown>>();

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" || attempt === 4) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await sleep(10 * (attempt + 1));
    }
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function writeState(root: string, state: LoopState): Promise<void> {
  await enqueueStateWrite(root, async () => {
    await writeJson(statePath(root), { ...state, updatedAt: new Date().toISOString() });
  });
}

export async function readState(root: string): Promise<LoopState> {
  return readJson<LoopState>(statePath(root));
}

export async function updateState(root: string, patch: Partial<LoopState>): Promise<LoopState> {
  return enqueueStateWrite(root, async () => {
    const current = await readState(root);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeJson(statePath(root), next);
    return next;
  });
}

export async function appendActivity(root: string, entry: Omit<ActivityEntry, "updatedAt">): Promise<LoopState> {
  return enqueueStateWrite(root, async () => {
    const current = await readState(root);
    const activityEntry = { ...entry, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(activityPath(root)), { recursive: true });
    await appendFile(activityPath(root), `${JSON.stringify(activityEntry)}\n`, "utf8");
    const nextActivity = [...(current.activity ?? []), activityEntry].slice(-30);
    const next = { ...current, activity: nextActivity, updatedAt: new Date().toISOString() };
    await writeJson(statePath(root), next);
    return next;
  });
}

export async function readActivityHistory(root: string): Promise<ActivityEntry[]> {
  if (!existsSync(activityPath(root))) {
    return (await readState(root)).activity ?? [];
  }
  const text = await readFile(activityPath(root), "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityEntry);
}

async function runAfter<T>(previous: Promise<unknown>, operation: () => Promise<T>): Promise<T> {
  try {
    await previous;
  } catch {
    // Previous queue entry's failure must not block the next one.
  }
  return operation();
}

export async function enqueueStateWrite<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateQueues.get(root) ?? Promise.resolve();
  const current = runAfter(previous, operation);
  stateQueues.set(root, current);
  try {
    return await current;
  } finally {
    if (stateQueues.get(root) === current) {
      stateQueues.delete(root);
    }
  }
}

export function isStopRequested(root: string): boolean {
  return existsSync(stopPath(root));
}

export async function listLoopDirs(workspaceDir: string): Promise<string[]> {
  const root = loopRoot(workspaceDir);
  if (!existsSync(root)) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => loopDir(workspaceDir, entry.name));
}
