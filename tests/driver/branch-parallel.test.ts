import { expect, test } from "bun:test";
import { BranchNodeStatus, runParallelBranch } from "../../driver/branches/parallel";

test("parallel branch runner records successful and failed nodes without serial coupling", async () => {
  const events: string[] = [];
  const result = await runParallelBranch({
    nodes: [{ id: "research-a" }, { id: "research-b" }, { id: "research-c" }],
    runNode: async (node) => {
      events.push(`run:${node.id}`);
      return node.id === "research-b"
        ? { ok: false, text: "failed" }
        : { ok: true, text: `done:${node.id}` };
    },
    onNodeCompleted: async (node) => {
      events.push(`completed:${node.id}`);
    },
    onNodeFailed: async (node) => {
      events.push(`failed:${node.id}`);
    },
  });

  expect(result.allFailed).toBe(false);
  expect(result.successful.map((item) => item.node.id).sort()).toEqual(["research-a", "research-c"]);
  expect(result.failed.map((item) => item.node.id)).toEqual(["research-b"]);
  expect(result.results.find((item) => item.node.id === "research-b")?.status).toBe(BranchNodeStatus.Failed);
  expect(events).toContain("completed:research-a");
  expect(events).toContain("failed:research-b");
});

test("parallel branch runner exposes all-failed branch state", async () => {
  const result = await runParallelBranch({
    nodes: [{ id: "worker-analysis" }, { id: "reviewer-analysis" }],
    runNode: async (node) => ({ ok: false, text: `${node.id} failed` }),
  });

  expect(result.allFailed).toBe(true);
  expect(result.successful).toEqual([]);
  expect(result.failed).toHaveLength(2);
});
