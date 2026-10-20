import { expect, test } from "bun:test";
import { isTerminal, progressPercent, toneFor } from "../../ui/state-view.js";

test("done status fills progress even before max iteration", () => {
  expect(progressPercent({ status: "done", iter: 1, maxIter: 2 })).toBe(100);
});

test("running progress follows iteration ratio", () => {
  expect(progressPercent({ status: "observers-running", iter: 1, maxIter: 2 })).toBe(50);
});

test("terminal and tone mapping match loop statuses", () => {
  expect(isTerminal("done")).toBe(true);
  expect(isTerminal("worker-running")).toBe(false);
  expect(isTerminal("cancelling")).toBe(false);
  expect(toneFor("done")).toBe("ok");
  expect(toneFor("cancelling")).toBe("run");
  expect(toneFor("max-iter-reached")).toBe("warn");
  expect(toneFor("failed")).toBe("bad");
});
