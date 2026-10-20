import { mkdir } from "node:fs/promises";
import path from "node:path";

export function loopRoot(workspaceDir: string): string {
  return path.join(workspaceDir, "looper", "loop-runs");
}

export function loopDir(workspaceDir: string, loopId: string): string {
  return path.join(loopRoot(workspaceDir), loopId);
}

export function iterDir(root: string, iter: number): string {
  return path.join(root, `iter-${iter}`);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function safeModelName(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}
