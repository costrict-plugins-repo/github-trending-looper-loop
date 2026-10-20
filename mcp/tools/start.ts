import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createLoopId } from "../../driver/ids";
import { spawnDetached } from "../../driver/platform";
import { loopDir } from "../../driver/paths";
import { AgentProvider, ReasoningEffort, type ModelRef } from "../../driver/runners/types";
import { NotifyKind, defaultObservers, defaultWorker, type LoopConfig } from "../../driver/state";

export type StartInput = {
  workspaceDir: string;
  task: string;
  maxIter: number;
  worker?: ModelRef;
  observers?: ModelRef[];
  stopCondition?: string;
  notify?: NotifyKind[];
};

export type StartOutput = {
  loop_id: string;
  statusUrl: string;
  dir: string;
  pid?: number;
};

export async function looperloopStart(input: StartInput): Promise<StartOutput> {
  if (!input.workspaceDir) {
    throw new Error("workspaceDir is required");
  }
  if (!input.task) {
    throw new Error("task is required");
  }
  if (!Number.isFinite(input.maxIter) || input.maxIter <= 0) {
    throw new Error("maxIter must be a positive number");
  }
  const loopId = createLoopId(input.workspaceDir);
  const dir = loopDir(input.workspaceDir, loopId);
  const worker = normalizeModelRef(input.worker ?? defaultWorker());
  const observers = input.observers?.length ? input.observers.map(normalizeModelRef) : defaultObservers();
  const notify = input.notify === undefined ? undefined : input.notify.length ? input.notify.join(",") : "none";
  const args = [
    "run",
    path.resolve(import.meta.dir, "../../driver/main.ts"),
    "--loop-id",
    loopId,
    "--workspace",
    input.workspaceDir,
    "--task",
    input.task,
    "--max",
    String(input.maxIter),
    "--worker",
    formatModelRef(worker),
    "--observers",
    observers.map(formatModelRef).join(","),
    "--stop-condition",
    input.stopCondition ?? input.task,
  ];
  if (notify !== undefined) {
    args.push("--notify", notify);
  }
  const pid = spawnDetached({ command: "bun", args, cwd: path.resolve(import.meta.dir, "../..") });
  let statusUrl = "pending; read looperloop_status after driver starts";
  const statePath = path.join(dir, "state.json");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as { statusUrl?: string };
        if (state.statusUrl) {
          statusUrl = state.statusUrl;
          break;
        }
      } catch {
        // Driver may be mid-write; retry briefly.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { loop_id: loopId, statusUrl, dir, pid };
}

function normalizeModelRef(model: ModelRef): ModelRef {
  return { ...model, effort: model.effort ?? ReasoningEffort.High };
}

function formatModelRef(model: ModelRef): string {
  return `${model.provider}:${model.model}:${model.effort ?? ReasoningEffort.High}`;
}
