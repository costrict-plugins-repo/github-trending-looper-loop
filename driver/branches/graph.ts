import { IssueState } from "../dispute/machine";
import { listIssues, type IssueAnalysisRecord, type IssueRecord } from "../dispute/store";
import { configPath, defaultObservers, defaultWorker, readJson, type LoopConfig } from "../state";
import { type ModelRef } from "../runners/types";

export enum BranchKind {
  Dispute = "dispute",
  Research = "research",
}

export enum BranchNodeKind {
  Branch = "branch",
  Analysis = "analysis",
  Synthesis = "synthesis",
}

export enum BranchGraphNodeStatus {
  Open = "open",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Blocking = "blocking",
  NonBlocking = "non-blocking",
}

export type BranchGraphNode = {
  id: string;
  kind: BranchNodeKind;
  branchKind: BranchKind;
  status: BranchGraphNodeStatus;
  label: string;
  file?: string;
};

export type BranchGraphEdge = {
  from: string;
  to: string;
  kind: "spawns" | "feeds";
};

export type BranchGraph = {
  nodes: BranchGraphNode[];
  edges: BranchGraphEdge[];
};

export type PreviewIssueAnalysis = {
  specId: string;
  role?: "worker" | "reviewer";
  model?: ModelRef;
  modelIndex?: number;
  status: "completed" | "failed";
  name: string;
  file: string;
};

export type PreviewIssue = {
  id: string;
  flag: string;
  raisedInIter: number;
  source: IssueRecord["source"];
  state: IssueState;
  machine: IssueRecord["machine"];
  originObserverIndex?: number;
  analysisNodes: PreviewIssueAnalysis[];
  synthesis?: IssueRecord["synthesis"];
  files: {
    issue: string;
    synthesis?: string;
    analyses: string[];
  };
};

export type PreviewGraphPayload = {
  branchGraph: BranchGraph;
  issues: PreviewIssue[];
  worker: ModelRef;
  observers: ModelRef[];
};

function issueStatus(state: IssueState): BranchGraphNodeStatus {
  if (state === IssueState.Open) {
    return BranchGraphNodeStatus.Open;
  }
  if (state === IssueState.Analyzing || state === IssueState.Synthesizing) {
    return BranchGraphNodeStatus.Running;
  }
  if (state === IssueState.Failed) {
    return BranchGraphNodeStatus.Failed;
  }
  if (state === IssueState.Cancelled) {
    return BranchGraphNodeStatus.Cancelled;
  }
  if (state === IssueState.Blocking) {
    return BranchGraphNodeStatus.Blocking;
  }
  if (state === IssueState.NonBlocking) {
    return BranchGraphNodeStatus.NonBlocking;
  }
  return BranchGraphNodeStatus.Completed;
}

function issueAnalysisStatus(issue: IssueRecord, index: number): BranchGraphNodeStatus {
  const node = issue.analysisNodes?.[index];
  if (node?.status === "failed") {
    return BranchGraphNodeStatus.Failed;
  }
  if (node?.status === "completed") {
    return BranchGraphNodeStatus.Completed;
  }
  if (issue.state === IssueState.Failed && issue.machine.completedAnalyses === 0) {
    return BranchGraphNodeStatus.Failed;
  }
  return BranchGraphNodeStatus.Completed;
}

export function branchGraphFromIssues(issues: IssueRecord[]): BranchGraph {
  const nodes: BranchGraphNode[] = [];
  const edges: BranchGraphEdge[] = [];
  for (const issue of issues) {
    const issueNodeId = `branch:${issue.id}`;
    nodes.push({
      id: issueNodeId,
      kind: BranchNodeKind.Branch,
      branchKind: BranchKind.Dispute,
      status: issueStatus(issue.state),
      label: issue.flag,
      file: issue.files.issue,
    });

    for (const [index, file] of issue.files.analyses.entries()) {
      const analysis = issue.analysisNodes?.[index];
      const analysisNodeId = `${issueNodeId}:analysis:${index + 1}`;
      nodes.push({
        id: analysisNodeId,
        kind: BranchNodeKind.Analysis,
        branchKind: BranchKind.Dispute,
        status: issueAnalysisStatus(issue, index),
        label: analysis?.name ?? `Analysis ${index + 1}`,
        file,
      });
      edges.push({ from: issueNodeId, to: analysisNodeId, kind: "spawns" });
    }

    if (issue.files.synthesis) {
      const synthesisNodeId = `${issueNodeId}:synthesis`;
      nodes.push({
        id: synthesisNodeId,
        kind: BranchNodeKind.Synthesis,
        branchKind: BranchKind.Dispute,
        status: issueStatus(issue.state),
        label: "Synthesis",
        file: issue.files.synthesis,
      });
      for (const [index] of issue.files.analyses.entries()) {
        edges.push({ from: `${issueNodeId}:analysis:${index + 1}`, to: synthesisNodeId, kind: "feeds" });
      }
    }
  }
  return { nodes, edges };
}

export async function readBranchGraph(loopDir: string): Promise<BranchGraph> {
  return branchGraphFromIssues(await listIssues(loopDir));
}

function analysisSpecId(analysis: IssueAnalysisRecord, index: number): string {
  return analysis.specId ?? `legacy-${index + 1}`;
}

function previewAnalysis(analysis: IssueAnalysisRecord, index: number): PreviewIssueAnalysis {
  return {
    specId: analysisSpecId(analysis, index),
    role: analysis.role,
    model: analysis.model,
    modelIndex: analysis.modelIndex,
    status: analysis.status,
    name: analysis.name,
    file: analysis.file,
  };
}

export function previewBranchGraphFromIssues(issues: IssueRecord[]): BranchGraph {
  const nodes: BranchGraphNode[] = [];
  const edges: BranchGraphEdge[] = [];
  for (const issue of issues) {
    const issueNodeId = `branch:${issue.id}`;
    nodes.push({
      id: issueNodeId,
      kind: BranchNodeKind.Branch,
      branchKind: BranchKind.Dispute,
      status: issueStatus(issue.state),
      label: issue.flag,
      file: issue.files.issue,
    });

    for (const [index, analysis] of (issue.analysisNodes ?? []).entries()) {
      const analysisNodeId = `${issueNodeId}:analysis:${analysisSpecId(analysis, index)}`;
      nodes.push({
        id: analysisNodeId,
        kind: BranchNodeKind.Analysis,
        branchKind: BranchKind.Dispute,
        status: analysis.status === "failed" ? BranchGraphNodeStatus.Failed : BranchGraphNodeStatus.Completed,
        label: analysis.name,
        file: analysis.file,
      });
      edges.push({ from: issueNodeId, to: analysisNodeId, kind: "spawns" });
    }

    if (issue.files.synthesis) {
      const synthesisNodeId = `${issueNodeId}:synthesis`;
      nodes.push({
        id: synthesisNodeId,
        kind: BranchNodeKind.Synthesis,
        branchKind: BranchKind.Dispute,
        status: issueStatus(issue.state),
        label: "Synthesis",
        file: issue.files.synthesis,
      });
      for (const [index, analysis] of (issue.analysisNodes ?? []).entries()) {
        edges.push({ from: `${issueNodeId}:analysis:${analysisSpecId(analysis, index)}`, to: synthesisNodeId, kind: "feeds" });
      }
    }
  }
  return { nodes, edges };
}

function issueToPreview(issue: IssueRecord): PreviewIssue {
  return {
    id: issue.id,
    flag: issue.flag,
    raisedInIter: issue.raisedInIter,
    source: issue.source,
    state: issue.state,
    machine: issue.machine,
    originObserverIndex: issue.originObserverIndex,
    analysisNodes: (issue.analysisNodes ?? []).map(previewAnalysis),
    synthesis: issue.synthesis,
    files: {
      issue: issue.files.issue,
      synthesis: issue.files.synthesis,
      analyses: issue.files.analyses,
    },
  };
}

async function readPreviewConfig(loopDir: string): Promise<Pick<LoopConfig, "worker" | "observers">> {
  try {
    const config = await readJson<LoopConfig>(configPath(loopDir));
    return { worker: config.worker, observers: config.observers };
  } catch {
    return { worker: defaultWorker(), observers: defaultObservers() };
  }
}

export async function readPreviewGraph(loopDir: string): Promise<PreviewGraphPayload> {
  const issues = await listIssues(loopDir);
  const config = await readPreviewConfig(loopDir);
  return {
    branchGraph: previewBranchGraphFromIssues(issues),
    issues: issues.map(issueToPreview),
    worker: config.worker,
    observers: config.observers,
  };
}
