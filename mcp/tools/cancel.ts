import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { terminateProcessTree } from "../../driver/platform";
import { completePath, configPath, LoopStatus, readJson, resultPath, statePath, writeJson, type LoopConfig, type LoopState } from "../../driver/state";
import { resolveLoopDir, type StatusInput } from "./status";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineFromNow(ms: number): number {
  return Date.now() + ms;
}

function hasPassed(deadline: number): boolean {
  return Date.now() >= deadline;
}

function cancelledSummary(state: Partial<LoopState>): string {
  return `Cancelled at iteration ${state.iter ?? 0} of ${state.maxIter ?? 0}.`;
}

export async function looperloopCancel(input: StatusInput): Promise<{ ok: true; stopPath: string; completed: boolean }> {
  const dir = await resolveLoopDir(input);
  const stopFile = path.join(dir, "STOP");
  await writeFile(stopFile, "cancelled by user\n", "utf8");

  let state: Partial<LoopState> = {};
  if (existsSync(statePath(dir))) {
    state = await readJson<LoopState>(statePath(dir));
  }
  if (state.activeChildPid) {
    await terminateProcessTree({ pid: state.activeChildPid, graceMs: 1000 });
  }

  const waitMs = Number(process.env.LOOPERLOOP_CANCEL_WAIT_MS ?? "5000");
  const completeFile = completePath(dir);
  const deadline = deadlineFromNow(waitMs);
  while (!hasPassed(deadline)) {
    if (existsSync(completeFile)) {
      return { ok: true, stopPath: stopFile, completed: true };
    }
    await sleep(100);
  }

  if (state.pid) {
    await terminateProcessTree({ pid: state.pid, graceMs: 1000 });
  }
  if (!existsSync(completeFile)) {
    const config = existsSync(configPath(dir)) ? await readJson<LoopConfig>(configPath(dir)) : undefined;
    const cancelledState = {
      ...state,
      loopId: state.loopId ?? input.loop_id,
      workspaceDir: state.workspaceDir ?? input.workspaceDir ?? process.cwd(),
      status: LoopStatus.Cancelled,
      currentActor: undefined,
      lastVerdict: "cancelled",
      resultSummary: cancelledSummary(state),
      updatedAt: new Date().toISOString(),
      warnings: [...(state.warnings ?? []), "Cancelled by looperloop_cancel fallback."],
    };
    await writeJson(resultPath(dir), {
      loopId: input.loop_id,
      outcome: "cancelled",
      completedAt: new Date().toISOString(),
      state: cancelledState,
      config,
    });
    await writeFile(completeFile, "cancelled\n", "utf8");
    await writeJson(statePath(dir), cancelledState);
  }
  return { ok: true, stopPath: stopFile, completed: existsSync(completeFile) };
}
