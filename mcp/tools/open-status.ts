import { existsSync } from "node:fs";
import { openStatusWindow, type WindowOptions } from "../../driver/platform";
import { LoopStatus, readJson, statePath, type LoopState } from "../../driver/state";
import { resolveLoopDir, type StatusInput } from "./status";

export type OpenStatusOutput = {
  ok: true;
  loop_id: string;
  status: LoopStatus;
  statusUrl: string;
};

type OpenStatusDeps = {
  openWindow?: (url: string, options: WindowOptions) => Promise<void>;
};

const terminalStatuses = new Set<LoopStatus>([
  LoopStatus.Done,
  LoopStatus.NeedsUser,
  LoopStatus.Aborted,
  LoopStatus.Cancelled,
  LoopStatus.MaxIterReached,
  LoopStatus.Failed,
]);

export async function looperloopOpenStatus(input: StatusInput, deps: OpenStatusDeps = {}): Promise<OpenStatusOutput> {
  const dir = await resolveLoopDir(input);
  const file = statePath(dir);
  if (!existsSync(file)) {
    throw new Error(`No state found for ${input.loop_id}`);
  }

  const state = await readJson<LoopState>(file);
  if (terminalStatuses.has(state.status)) {
    throw new Error(`Loop ${input.loop_id} is not running; current status is ${state.status}. Use looperloop_result for completed runs.`);
  }
  if (!state.statusUrl) {
    throw new Error(`Loop ${input.loop_id} does not have a status URL yet. Try looperloop_status again shortly.`);
  }

  await (deps.openWindow ?? openStatusWindow)(state.statusUrl, { width: 420, height: 640 });
  return {
    ok: true,
    loop_id: input.loop_id,
    status: state.status,
    statusUrl: state.statusUrl,
  };
}
