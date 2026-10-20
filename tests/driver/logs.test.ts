import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { looperloopLogs } from "../../mcp/tools/logs";
import { looperloopTail } from "../../mcp/tools/tail";
import { tempWorkspace } from "./helpers";

test("logs returns markdown and raw paths; tail defaults to worker log", async () => {
  const workspaceDir = await tempWorkspace();
  const dir = path.join(workspaceDir, "looper", "loop-runs", "loop-logs", "iter-1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "worker.log.md"), "one\ntwo\nthree\n", "utf8");
  await writeFile(path.join(dir, "worker.turn1.jsonl"), "{\"ok\":true}\n", "utf8");
  const logs = await looperloopLogs({ workspaceDir, loop_id: "loop-logs", iter: 1 });
  expect(Object.keys(logs.markdown).length).toBe(1);
  expect(logs.raw.some((file) => file.endsWith("worker.turn1.jsonl"))).toBe(true);
  const tail = await looperloopTail({ workspaceDir, loop_id: "loop-logs", lines: 2 });
  expect(tail.text).toContain("three");
});
