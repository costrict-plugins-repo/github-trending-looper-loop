import { expect, test } from "bun:test";
import { extractLooperloopSummary } from "../../driver/activity-summary";
import { buildObserverPrompt, buildWorkerLogPrompt } from "../../driver/prompt";
import { WorkerSignal } from "../../driver/runners/types";
import { tempWorkspace } from "./helpers";

test("extracts and normalizes looperloop summary fenced block", () => {
  const summary = extractLooperloopSummary(`# Worker Log

\`\`\`looperloop-summary
Updated the graph canvas so reviewer nodes sit beside worker nodes.
Added tests for future-node fading.
\`\`\`

Details continue here.`);

  expect(summary).toBe("Updated the graph canvas so reviewer nodes sit beside worker nodes. Added tests for future-node fading.");
});

test("ignores markdown without a looperloop summary block", () => {
  expect(extractLooperloopSummary("# Worker Log\n\nNo summary here.")).toBeUndefined();
});

test("caps long summaries before storing them in activity", () => {
  const summary = extractLooperloopSummary(`\`\`\`looperloop-summary
${"x".repeat(500)}
\`\`\``);

  expect(summary?.length).toBeLessThanOrEqual(360);
  expect(summary?.endsWith("...")).toBe(true);
});

test("worker and observer prompts require looperloop summary blocks", async () => {
  const loopDir = await tempWorkspace();
  const workerPrompt = buildWorkerLogPrompt({ loopDir, iter: 1 });
  const observerPrompt = await buildObserverPrompt({
    loopDir,
    iter: 1,
    task: "finish",
    stopCondition: "finish is done",
    workerSignal: WorkerSignal.None,
  });

  expect(workerPrompt).toContain("```looperloop-summary");
  expect(workerPrompt).toContain("1-2 short sentences");
  expect(observerPrompt).toContain("```looperloop-summary");
  expect(observerPrompt).toContain("Your final response must end");
  expect(observerPrompt).toContain("Escalation and blocking policy");
  expect(observerPrompt).toContain("cannot continue safely or meaningfully");
  expect(observerPrompt).toContain("ordinary engineering uncertainty");
});
