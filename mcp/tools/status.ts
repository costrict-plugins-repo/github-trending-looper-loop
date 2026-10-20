import path from "node:path";
import { existsSync } from "node:fs";
import { readJson, type ActivityEntry, type LoopState } from "../../driver/state";

export type StatusInput = {
  workspaceDir?: string;
  loop_id: string;
};

export async function resolveLoopDir(input: StatusInput): Promise<string> {
  const workspaceDir = input.workspaceDir ?? process.cwd();
  return path.join(workspaceDir, "looper", "loop-runs", input.loop_id);
}

export type StatusOutput = {
  iter: number;
  maxIter: number;
  status: string;
  lastVerdict?: string;
  elapsed: number;
  currentActor?: string;
  statusUrl?: string;
  resultSummary?: string;
  activity: ActivityEntry[];
};

function elapsedSinceMs(isoStart: string): number {
  return Date.now() - Date.parse(isoStart);
}

export async function looperloopStatus(input: StatusInput): Promise<StatusOutput> {
  const dir = await resolveLoopDir(input);
  const file = path.join(dir, "state.json");
  if (!existsSync(file)) {
    throw new Error(`No state found for ${input.loop_id}`);
  }
  const state = await readJson<LoopState>(file);
  return {
    iter: state.iter,
    maxIter: state.maxIter,
    status: state.status,
    lastVerdict: state.lastVerdict,
    elapsed: elapsedSinceMs(state.startedAt),
    currentActor: state.currentActor,
    statusUrl: state.statusUrl,
    resultSummary: state.resultSummary,
    activity: state.activity ?? [],
  };
}
