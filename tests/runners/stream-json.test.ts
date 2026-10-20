import { expect, test } from "bun:test";
import { parseObserverVerdict, parseWorkerSignal } from "../../driver/runners/sentinels";
import { parseStreamJsonLines } from "../../driver/runners/stream-json";
import { AgentProvider, ObserverVerdict, WorkerSignal } from "../../driver/runners/types";

test("prefers terminal result text over duplicate assistant text", () => {
  const lines = [
    JSON.stringify({ type: "system", session_id: "claude-session" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OBSERVER_VERDICT: done" }] } }),
    JSON.stringify({ type: "result", result: "OBSERVER_VERDICT: done" }),
  ];

  const parsed = parseStreamJsonLines(lines, AgentProvider.ClaudeCli);

  expect(parsed.finalAssistantText).toBe("OBSERVER_VERDICT: done");
  expect(parseObserverVerdict(parsed.finalAssistantText)).toBe(ObserverVerdict.Done);
});

test("keeps worker completion sentinel parseable when result repeats assistant text", () => {
  const lines = [
    JSON.stringify({ type: "system", session_id: "claude-session" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "COMPLETION_PROMISE_SATISFIED: CONFIRMED" }] },
    }),
    JSON.stringify({ type: "result", result: "COMPLETION_PROMISE_SATISFIED: CONFIRMED" }),
  ];

  const parsed = parseStreamJsonLines(lines, AgentProvider.ClaudeCli);

  expect(parsed.finalAssistantText).toBe("COMPLETION_PROMISE_SATISFIED: CONFIRMED");
  expect(parseWorkerSignal(parsed.finalAssistantText).signal).toBe(WorkerSignal.Done);
});
