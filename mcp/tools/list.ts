import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJson, type LoopState } from "../../driver/state";

export async function looperloopList(input: { workspaceDir: string }): Promise<LoopState[]> {
  const root = path.join(input.workspaceDir, "looper", "loop-runs");
  if (!existsSync(root)) {
    return [];
  }
  const dirs = await readdir(root, { withFileTypes: true });
  const states: LoopState[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const statePath = path.join(root, dir.name, "state.json");
    if (existsSync(statePath)) {
      states.push(await readJson<LoopState>(statePath));
    }
  }
  return states;
}
