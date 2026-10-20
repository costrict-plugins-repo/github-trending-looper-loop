import { expect, test } from "bun:test";
import { branchGraphFromIssues, BranchGraphNodeStatus, BranchKind, BranchNodeKind } from "../../driver/branches/graph";
import { IssueState } from "../../driver/dispute/machine";
import { ProposedResolution, SynthesisKind } from "../../driver/dispute/protocol";
import { createIssue, IssueSource, listIssues, startIssueAnalyses, writeIssueAnalysis, writeIssueAnalysisFailure, writeIssueSynthesis } from "../../driver/dispute/store";
import { loopDir } from "../../driver/paths";
import { tempWorkspace } from "./helpers";

const dispute = {
  flag: "Research dependency risk",
  raisedInIter: 2,
  workerPosition: "Needs independent validation.",
  proposedResolution: ProposedResolution.NeedsUserDecision,
  evidence: ["Reviewer requested side work."],
};

test("branch graph projects issue branches into generic nodes and edges", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-branch-graph");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await startIssueAnalyses(root, issue.id, 2);
  await writeIssueAnalysis(root, issue.id, "worker-opus", "worker analysis");
  await writeIssueAnalysisFailure(root, issue.id, "reviewer-opus", "reviewer failed");
  await writeIssueSynthesis(root, issue.id, "synthesis", {
    issueId: issue.id,
    kind: SynthesisKind.NonBlocking,
    reason: "Carry it forward.",
  });

  const graph = branchGraphFromIssues(await listIssues(root));
  expect(graph.nodes.find((node) => node.id === "branch:issue-001")).toMatchObject({
    kind: BranchNodeKind.Branch,
    branchKind: BranchKind.Dispute,
    status: BranchGraphNodeStatus.NonBlocking,
    label: "Research dependency risk",
  });
  expect(graph.nodes.find((node) => node.label === "worker-opus")).toMatchObject({
    kind: BranchNodeKind.Analysis,
    status: BranchGraphNodeStatus.Completed,
  });
  expect(graph.nodes.find((node) => node.label === "reviewer-opus")).toMatchObject({
    kind: BranchNodeKind.Analysis,
    status: BranchGraphNodeStatus.Failed,
  });
  expect(graph.nodes.find((node) => node.kind === BranchNodeKind.Synthesis)).toMatchObject({
    status: BranchGraphNodeStatus.NonBlocking,
  });
  expect(graph.edges).toContainEqual({ from: "branch:issue-001", to: "branch:issue-001:analysis:1", kind: "spawns" });
  expect(graph.edges).toContainEqual({ from: "branch:issue-001:analysis:1", to: "branch:issue-001:synthesis", kind: "feeds" });
});

test("branch graph marks all-failed issue branch without synthesis node", async () => {
  const workspaceDir = await tempWorkspace();
  const root = loopDir(workspaceDir, "loop-branch-graph-failed");
  const issue = await createIssue(root, { dispute, source: IssueSource.Observer });

  await startIssueAnalyses(root, issue.id, 1);
  await writeIssueAnalysisFailure(root, issue.id, "worker-opus", "worker failed");

  const [stored] = await listIssues(root);
  expect(stored.state).toBe(IssueState.Failed);
  const graph = branchGraphFromIssues([stored]);
  expect(graph.nodes.find((node) => node.id === "branch:issue-001")?.status).toBe(BranchGraphNodeStatus.Failed);
  expect(graph.nodes.some((node) => node.kind === BranchNodeKind.Synthesis)).toBe(false);
});
