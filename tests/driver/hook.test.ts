import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectCompletionContext } from "../../hooks/on-prompt";
import { tempWorkspace } from "./helpers";

test("hook returns additional completion context and dedupes seen loops", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-hook");
  await mkdir(loopDir, { recursive: true });
  await writeFile(path.join(loopDir, "COMPLETE"), "done\n", "utf8");
  await writeFile(path.join(loopDir, "RESULT.json"), JSON.stringify({ outcome: "done" }), "utf8");
  const seen = path.join(workspaceDir, "seen.json");
  const first = await collectCompletionContext(workspaceDir, seen);
  expect(first).toContain("Loop loop-hook finished: done");
  const second = await collectCompletionContext(workspaceDir, seen);
  expect(second).toBe("");
});
