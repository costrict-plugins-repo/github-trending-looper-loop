import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { looperloopCancel } from "../../mcp/tools/cancel";
import { tempWorkspace } from "./helpers";

test("cancel writes STOP file", async () => {
  process.env.LOOPERLOOP_CANCEL_WAIT_MS = "1";
  const workspaceDir = await tempWorkspace();
  const dir = path.join(workspaceDir, "looper", "loop-runs", "loop-cancel");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ loopId: "loop-cancel", workspaceDir, iter: 2, maxIter: 5, warnings: [] }), "utf8");
  const result = await looperloopCancel({ workspaceDir, loop_id: "loop-cancel" });
  expect(result.ok).toBe(true);
  expect(existsSync(path.join(dir, "STOP"))).toBe(true);
  expect(existsSync(path.join(dir, "COMPLETE"))).toBe(true);
  const final = JSON.parse(await readFile(path.join(dir, "RESULT.json"), "utf8"));
  expect(final.outcome).toBe("cancelled");
  expect(final.state.resultSummary).toBe("Cancelled at iteration 2 of 5.");
  expect(final.state.lastVerdict).toBe("cancelled");
});
