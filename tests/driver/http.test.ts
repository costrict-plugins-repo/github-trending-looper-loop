import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startStatusServer } from "../../driver/http";
import { IssueSource, createIssue } from "../../driver/dispute/store";
import { ProposedResolution } from "../../driver/dispute/protocol";
import { AgentProvider, ReasoningEffort } from "../../driver/runners/types";
import { appendActivity, configPath, writeJson, writeState, ActivityStage, ActivityStatus, LoopStatus, NotifyKind, type LoopConfig } from "../../driver/state";
import { tempWorkspace } from "./helpers";

test("status server serves run-scoped state, assets, and stop endpoint", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-http");
  await mkdir(loopDir, { recursive: true });
  await writeState(loopDir, {
    loopId: "loop-http",
    workspaceDir,
    iter: 1,
    maxIter: 2,
    status: LoopStatus.WorkerRunning,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
  });
  const server = await startStatusServer(loopDir);
  try {
    expect(server.url).toContain("/runs/loop-http/");
    const indexHtml = await fetch(server.url).then((response) => response.text());
    expect(indexHtml).toContain('src="./app.js"');
    const appScript = await fetch(new URL("app.js", server.url));
    expect(appScript.status).toBe(200);
    const state = await fetch(new URL("state", server.url)).then((response) => response.json());
    expect(state.loopId).toBe("loop-http");
    const wrongRun = await fetch(`http://localhost:${server.port}/runs/loop-other/state`);
    expect(wrongRun.status).toBe(404);
    const events = await fetch(new URL("events", server.url));
    expect(events.status).toBe(404);
    await server.broadcast();
    const stopResponse = await fetch(new URL("stop", server.url), { method: "POST" });
    expect(await stopResponse.json()).toEqual({ ok: true });
    expect(await Bun.file(path.join(loopDir, "STOP")).text()).toContain("stop");
    const stoppedState = await fetch(new URL("state", server.url)).then((response) => response.json());
    expect(stoppedState.status).toBe(LoopStatus.Cancelling);
    expect(stoppedState.currentActor).toBe("cancelling");
  } finally {
    server.close();
  }
});

test("status server serves full activity history from activity jsonl", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-activity");
  await mkdir(loopDir, { recursive: true });
  await writeState(loopDir, {
    loopId: "loop-activity",
    workspaceDir,
    iter: 1,
    maxIter: 40,
    status: LoopStatus.WorkerRunning,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
  });
  for (let index = 1; index <= 35; index += 1) {
    await appendActivity(loopDir, {
      iter: index,
      stage: ActivityStage.Decision,
      status: ActivityStatus.Done,
      title: `Decision ${index}`,
    });
  }

  const server = await startStatusServer(loopDir);
  try {
    const state = await fetch(new URL("state", server.url)).then((response) => response.json());
    expect(state.activity).toHaveLength(30);
    const history = await fetch(new URL("activity", server.url)).then((response) => response.json());
    expect(history.activity).toHaveLength(35);
    expect(history.activity[0].title).toBe("Decision 1");
    expect(history.activity.at(-1).title).toBe("Decision 35");
  } finally {
    server.close();
  }
});

test("status server exposes preview graph DTO", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-graph");
  await mkdir(loopDir, { recursive: true });
  await writeState(loopDir, {
    loopId: "loop-graph",
    workspaceDir,
    iter: 1,
    maxIter: 2,
    status: LoopStatus.AnalyzingDispute,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
  });
  await writeJson(configPath(loopDir), {
    loopId: "loop-graph",
    workspaceDir,
    task: "secret prompt",
    maxIter: 2,
    worker: { provider: AgentProvider.ClaudeCli, model: "opus", effort: ReasoningEffort.Low },
    observers: [{ provider: AgentProvider.CodexCli, model: "gpt-5.5", effort: ReasoningEffort.Low }],
    stopCondition: "done",
    notify: [NotifyKind.Sound],
  } satisfies LoopConfig);
  await createIssue(loopDir, {
    source: IssueSource.Observer,
    originObserverIndex: 0,
    dispute: {
      flag: "Needs side review",
      raisedInIter: 1,
      workerPosition: "Maybe done.",
      proposedResolution: ProposedResolution.NeedsUserDecision,
      evidence: ["reviewer asked"],
    },
  });

  const server = await startStatusServer(loopDir);
  try {
    const graph = await fetch(new URL("graph", server.url)).then((response) => response.json());
    expect(graph.worker.model).toBe("opus");
    expect(graph.observers[0].model).toBe("gpt-5.5");
    expect(graph.issues[0].originObserverIndex).toBe(0);
    expect("task" in graph).toBe(false);
    expect("workspaceDir" in graph).toBe(false);

    await server.broadcast();
  } finally {
    server.close();
  }
});
