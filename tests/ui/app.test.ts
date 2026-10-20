import { afterEach, expect, test } from "bun:test";

class FakeElement {
  textContent: unknown = "";
  hidden = false;
  disabled = false;
  className = "";
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
}

type TestGlobals = {
  document?: unknown;
  EventSource?: unknown;
  fetch?: unknown;
  setInterval?: unknown;
};

const globals = globalThis as unknown as TestGlobals;
const originalGlobals: TestGlobals = {
  document: globals.document,
  EventSource: globals.EventSource,
  fetch: globals.fetch,
  setInterval: globals.setInterval,
};

let intervals: (() => void)[] = [];

afterEach(() => {
  if (originalGlobals.document === undefined) {
    delete globals.document;
  } else {
    globals.document = originalGlobals.document;
  }
  globals.fetch = originalGlobals.fetch;
  if (originalGlobals.EventSource === undefined) {
    delete globals.EventSource;
  } else {
    globals.EventSource = originalGlobals.EventSource;
  }
  globals.setInterval = originalGlobals.setInterval;
  intervals = [];
});

function installDom(state: unknown, calls: string[] = []): Map<string, FakeElement> {
  const elements = new Map(
    [
      "loopId",
      "iterCurrent",
      "iterTotal",
      "statusPill",
      "status",
      "warnings",
      "stop",
      "activityCard",
      "activity",
      "canvasCard",
      "graphCanvas",
      "canvasReset",
      "canvasTooltip",
      "graphTable",
      "activityTab",
      "canvasTab",
    ].map((id) => [id, new FakeElement()] as const),
  );

  globals.document = {
    createElement: () => new FakeElement(),
    querySelector: (selector: string) => elements.get(selector.replace(/^#/, "")),
  };
  globals.fetch = async (input: string) => {
    calls.push(String(input));
    if (String(input).includes("activity")) {
      return { json: async () => ({ activity: (state as { activity?: unknown[] }).activity ?? [] }) };
    }
    if (String(input).includes("graph")) {
      return { json: async () => ({ issues: [], observers: [] }) };
    }
    return { json: async () => state };
  };
  globals.setInterval = (callback: () => void) => {
    intervals.push(callback);
    return intervals.length;
  };
  globals.EventSource = class {
    constructor() {
      throw new Error("EventSource should not be created");
    }
  };

  return elements;
}

test("app renders terminal activity and hides stop", async () => {
  const elements = installDom({
    loopId: "loop-ui",
    iter: 2,
    maxIter: 3,
    status: "done",
    lastVerdict: "done",
    resultSummary: "Done in 2 of 3 iterations.",
    activity: [
      { iter: 1, status: "done", title: "Worker finished this iteration", summary: "The goal is not marked complete yet." },
      { iter: 2, status: "done", title: "Decision: done", summary: "The worker and reviewer agree." },
    ],
    warnings: [],
  });

  await import(`../../ui/app.js?app-test=${crypto.randomUUID()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(elements.get("stop")?.disabled).toBe(true);
  expect(elements.get("stop")?.hidden).toBe(true);
  expect(elements.get("activityCard")?.hidden).toBe(true);
  expect(elements.get("canvasCard")?.hidden).toBe(false);
  expect(elements.get("activity")?.children).toHaveLength(2);
  const firstActivityTitle = elements.get("activity")?.children[0]?.children[0]?.children[0]?.textContent;
  expect(firstActivityTitle).toBe("Decision: done");
});

test("app prepends live actor row and aligns live status with summary", async () => {
  const elements = installDom({
    loopId: "loop-ui",
    iter: 1,
    maxIter: 3,
    status: "worker-running",
    currentActor: "worker.turn1",
    activity: [
      { iter: 1, status: "failed", title: "sonnet reviewer finished", summary: "The reviewer thinks another iteration is needed." },
    ],
    warnings: [],
  });

  await import(`../../ui/app.js?app-test=${crypto.randomUUID()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(elements.get("activity")?.children).toHaveLength(2);
  const liveRow = elements.get("activity")?.children[0];
  expect(liveRow?.dataset.live).toBe("true");
  expect(liveRow?.children[0]?.children[0]?.textContent).toBe("Worker is making changes");
  expect(liveRow?.children[1]?.children[0]?.textContent).toBe("The agent is working in the project.");
  expect(liveRow?.children[1]?.children[1]?.textContent).toBe("iteration 1 - running");
});

test("app shows cancellation as a live stopping row", async () => {
  const elements = installDom({
    loopId: "loop-ui",
    iter: 3,
    maxIter: 4,
    status: "cancelling",
    currentActor: "cancelling",
    activity: [],
    warnings: [],
  });

  await import(`../../ui/app.js?app-test=${crypto.randomUUID()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(elements.get("stop")?.disabled).toBe(true);
  expect(elements.get("stop")?.hidden).toBe(false);
  const liveRow = elements.get("activity")?.children[0];
  expect(liveRow?.dataset.live).toBe("true");
  expect(liveRow?.children[0]?.children[0]?.textContent).toBe("Cancellation requested");
  expect(liveRow?.children[1]?.children[0]?.textContent).toBe("LooperLoop is stopping the active agent and saving the run state.");
});

test("app polls state, activity, and graph without opening EventSource", async () => {
  const calls: string[] = [];
  installDom({
    loopId: "loop-ui",
    iter: 1,
    maxIter: 3,
    status: "worker-running",
    currentActor: "worker.turn1",
    activity: [],
    warnings: [],
  }, calls);

  await import(`../../ui/app.js?app-test=${crypto.randomUUID()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContain("./state");
  expect(calls).toContain("./activity");
  expect(calls).toContain("./graph");
  expect(calls).not.toContain("./events");
  expect(intervals).toHaveLength(1);
});
