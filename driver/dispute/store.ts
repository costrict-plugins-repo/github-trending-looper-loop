import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IssueEventKind,
  IssueResolutionKind,
  IssueState,
  initialIssueMachineState,
  isTerminalIssueState,
  transitionIssue,
  type IssueMachineState,
} from "./machine";
import {
  RecommendedResolution,
  SynthesisKind,
  type Dispute,
  type DisputeResponse,
  type SynthesisVerdict,
  validateSynthesis,
} from "./protocol";
import { enqueueStateWrite, readJson, writeJson } from "../state";
import { type ModelRef } from "../runners/types";

export enum IssueSource {
  Observer = "observer",
  DeadlockDetector = "deadlock-detector",
}

export type IssueFiles = {
  dir: string;
  issue: string;
  dispute: string;
  record: string;
  synthesis?: string;
  synthesisJson?: string;
  analyses: string[];
};

export type IssueAnalysisRole = "worker" | "reviewer";

export type IssueAnalysisInput = {
  name: string;
  specId: string;
  role: IssueAnalysisRole;
  model: ModelRef;
  modelIndex: number;
};

export type IssueAnalysisRecord = {
  name: string;
  status: "completed" | "failed";
  file: string;
  specId?: string;
  role?: IssueAnalysisRole;
  model?: ModelRef;
  modelIndex?: number;
};

export type IssueRecord = {
  id: string;
  flag: string;
  raisedInIter: number;
  source: IssueSource;
  originObserverIndex?: number;
  state: IssueState;
  machine: IssueMachineState;
  dispute: Dispute;
  responses: DisputeResponse[];
  synthesis?: SynthesisVerdict;
  analysisNodes: IssueAnalysisRecord[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  files: IssueFiles;
};

export type CreateIssueInput = {
  dispute: Dispute;
  source: IssueSource;
  responses?: DisputeResponse[];
  originObserverIndex?: number;
};

export type StoreWriteOptions = {
  onMutate?: () => void | Promise<void>;
};

export type OpenQuestion = {
  issueId: string;
  flag: string;
  state: IssueState.NonBlocking | IssueState.Blocking;
  summary: string;
  blockReason?: string;
  userQuestion?: string;
  files: {
    issue: string;
    synthesis?: string;
    analyses: string[];
  };
};

function issuesDir(loopDir: string): string {
  return path.join(loopDir, "issues");
}

export function issueDir(loopDir: string, issueId: string): string {
  return path.join(issuesDir(loopDir), issueId);
}

function issueRecordPath(loopDir: string, issueId: string): string {
  return path.join(issueDir(loopDir, issueId), "issue.json");
}

export function disputesPath(loopDir: string): string {
  return path.join(loopDir, "disputes.json");
}

function issueMarkdownPath(loopDir: string, issueId: string): string {
  return path.join(issueDir(loopDir, issueId), "issue.md");
}

function issueDisputePath(loopDir: string, issueId: string): string {
  return path.join(issueDir(loopDir, issueId), "dispute.json");
}

function issueSynthesisPath(loopDir: string, issueId: string): string {
  return path.join(issueDir(loopDir, issueId), "synthesis.md");
}

function issueVerdictPath(loopDir: string, issueId: string): string {
  return path.join(issueDir(loopDir, issueId), "synthesis.json");
}

function issueFiles(loopDir: string, issueId: string): IssueFiles {
  const dir = issueDir(loopDir, issueId);
  return {
    dir,
    issue: issueMarkdownPath(loopDir, issueId),
    dispute: issueDisputePath(loopDir, issueId),
    record: issueRecordPath(loopDir, issueId),
    synthesis: existsSync(issueSynthesisPath(loopDir, issueId)) ? issueSynthesisPath(loopDir, issueId) : undefined,
    synthesisJson: existsSync(issueVerdictPath(loopDir, issueId)) ? issueVerdictPath(loopDir, issueId) : undefined,
    analyses: [],
  };
}

async function nextIssueId(loopDir: string): Promise<string> {
  if (!existsSync(issuesDir(loopDir))) {
    return "issue-001";
  }
  const entries = await readdir(issuesDir(loopDir), { withFileTypes: true });
  const max = entries
    .filter((entry) => entry.isDirectory() && /^issue-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("issue-".length)))
    .reduce((current, value) => Math.max(current, value), 0);
  return `issue-${String(max + 1).padStart(3, "0")}`;
}

function issueMarkdown(record: IssueRecord): string {
  const evidence = record.dispute.evidence.length
    ? record.dispute.evidence.map((item) => `- ${item}`).join("\n")
    : "- No evidence listed.";
  return `# ${record.id}: ${record.flag}

Raised in iteration: ${record.raisedInIter}
Source: ${record.source}
State: ${record.state}

## Worker Position

${record.dispute.workerPosition}

## Proposed Resolution

${record.dispute.proposedResolution}

## Evidence

${evidence}
`;
}

async function writeIssueFiles(loopDir: string, record: IssueRecord): Promise<IssueRecord> {
  const now = new Date().toISOString();
  const next = {
    ...record,
    updatedAt: now,
    files: {
      ...record.files,
      synthesis: existsSync(issueSynthesisPath(loopDir, record.id)) ? issueSynthesisPath(loopDir, record.id) : record.files.synthesis,
      synthesisJson: existsSync(issueVerdictPath(loopDir, record.id)) ? issueVerdictPath(loopDir, record.id) : record.files.synthesisJson,
    },
  };
  await mkdir(issueDir(loopDir, record.id), { recursive: true });
  await writeFile(next.files.issue, issueMarkdown(next), "utf8");
  await writeJson(next.files.dispute, next.dispute);
  await writeJson(next.files.record, next);
  return next;
}

async function writeIssueRegistry(loopDir: string): Promise<void> {
  const records = await listIssues(loopDir);
  await writeJson(disputesPath(loopDir), records);
}

async function afterMutation<T>(work: Promise<T>, options?: StoreWriteOptions): Promise<T> {
  const result = await work;
  await options?.onMutate?.();
  return result;
}

function normalizeAnalysisInput(input: string | IssueAnalysisInput): IssueAnalysisInput | { name: string } {
  return typeof input === "string" ? { name: input } : input;
}

export async function createIssue(loopDir: string, input: CreateIssueInput, options?: StoreWriteOptions): Promise<IssueRecord> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const id = await nextIssueId(loopDir);
    const now = new Date().toISOString();
    const machine = initialIssueMachineState();
    const record: IssueRecord = {
      id,
      flag: input.dispute.flag,
      raisedInIter: input.dispute.raisedInIter,
      source: input.source,
      originObserverIndex: input.source === IssueSource.Observer ? input.originObserverIndex : undefined,
      state: machine.state,
      machine,
      dispute: input.dispute,
      responses: input.responses ?? [],
      analysisNodes: [],
      warnings: [],
      createdAt: now,
      updatedAt: now,
      files: issueFiles(loopDir, id),
    };
    const saved = await writeIssueFiles(loopDir, record);
    await writeIssueRegistry(loopDir);
    return saved;
  }), options);
}

export async function readIssue(loopDir: string, issueId: string): Promise<IssueRecord> {
  return readJson<IssueRecord>(issueRecordPath(loopDir, issueId));
}

export async function saveIssue(loopDir: string, record: IssueRecord): Promise<IssueRecord> {
  return enqueueStateWrite(loopDir, async () => {
    const saved = await writeIssueFiles(loopDir, record);
    await writeIssueRegistry(loopDir);
    return saved;
  });
}

export async function listIssues(loopDir: string): Promise<IssueRecord[]> {
  if (!existsSync(issuesDir(loopDir))) {
    return [];
  }
  const entries = await readdir(issuesDir(loopDir), { withFileTypes: true });
  const records: IssueRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^issue-\d+$/.test(entry.name)) {
      continue;
    }
    const file = issueRecordPath(loopDir, entry.name);
    if (existsSync(file)) {
      records.push(await readJson<IssueRecord>(file));
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeIssueAnalysis(loopDir: string, issueId: string, analysis: string | IssueAnalysisInput, text: string, options?: StoreWriteOptions): Promise<string> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const normalized = normalizeAnalysisInput(analysis);
    const file = path.join(issueDir(loopDir, issueId), `analysis-${normalized.name}.md`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    const record = await readIssue(loopDir, issueId);
    if (!record.files.analyses.includes(file)) {
      const machine = transitionIssue(record.machine, { kind: IssueEventKind.AnalysisCompleted });
      const analysisNodes = [...(record.analysisNodes ?? []), { ...normalized, status: "completed" as const, file }];
      await writeIssueFiles(loopDir, {
        ...record,
        state: machine.state,
        machine,
        analysisNodes,
        files: { ...record.files, analyses: [...record.files.analyses, file] },
      });
      await writeIssueRegistry(loopDir);
    }
    return file;
  }), options);
}

export async function writeIssueAnalysisFailure(loopDir: string, issueId: string, analysis: string | IssueAnalysisInput, text: string, options?: StoreWriteOptions): Promise<string> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const normalized = normalizeAnalysisInput(analysis);
    const file = path.join(issueDir(loopDir, issueId), `analysis-${normalized.name}.md`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    const record = await readIssue(loopDir, issueId);
    if (!record.files.analyses.includes(file)) {
      const machine = transitionIssue(record.machine, { kind: IssueEventKind.AnalysisFailed });
      const analysisNodes = [...(record.analysisNodes ?? []), { ...normalized, status: "failed" as const, file }];
      await writeIssueFiles(loopDir, {
        ...record,
        state: machine.state,
        machine,
        analysisNodes,
        files: { ...record.files, analyses: [...record.files.analyses, file] },
      });
      await writeIssueRegistry(loopDir);
    }
    return file;
  }), options);
}

export async function startIssueAnalyses(loopDir: string, issueId: string, analyses: number, options?: StoreWriteOptions): Promise<IssueRecord> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const record = await readIssue(loopDir, issueId);
    const machine = transitionIssue(record.machine, { kind: IssueEventKind.Raise, analyses });
    const saved = await writeIssueFiles(loopDir, { ...record, state: machine.state, machine });
    await writeIssueRegistry(loopDir);
    return saved;
  }), options);
}

export async function writeIssueSynthesis(loopDir: string, issueId: string, text: string, synthesis: SynthesisVerdict, options?: StoreWriteOptions): Promise<IssueRecord> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const validated = validateSynthesis(synthesis);
    if (validated.value.issueId !== issueId) {
      throw new Error(`Synthesis issueId mismatch: expected ${issueId}, got ${validated.value.issueId || "<empty>"}`);
    }
    const record = await readIssue(loopDir, issueId);
    if (isTerminalIssueState(record.state)) {
      return record;
    }
    await mkdir(issueDir(loopDir, issueId), { recursive: true });
    await writeFile(issueSynthesisPath(loopDir, issueId), text, "utf8");
    await writeJson(issueVerdictPath(loopDir, issueId), validated.value);
    const readyMachine = record.machine.state === IssueState.Synthesizing
      ? record.machine
      : {
        ...record.machine,
        state: IssueState.Synthesizing,
        totalAnalyses: Math.max(record.machine.totalAnalyses, 1),
        pendingAnalyses: 0,
        completedAnalyses: Math.max(record.machine.completedAnalyses, 1),
      };
    const nextMachine = transitionIssue(readyMachine, {
      kind: IssueEventKind.Synthesis,
      verdict: {
        kind: synthesisKindToIssueResolution(validated.value.kind),
        blockReason: validated.value.blockReason,
      },
    });
    const saved = await writeIssueFiles(loopDir, {
      ...record,
      state: nextMachine.state,
      machine: nextMachine,
      synthesis: validated.value,
      warnings: [...record.warnings, ...validated.warnings, ...nextMachine.warnings],
      files: {
        ...record.files,
        synthesis: issueSynthesisPath(loopDir, issueId),
        synthesisJson: issueVerdictPath(loopDir, issueId),
      },
    });
    await writeIssueRegistry(loopDir);
    return saved;
  }), options);
}

function synthesisKindToIssueResolution(kind: SynthesisKind): IssueResolutionKind {
  if (kind === SynthesisKind.Resolved) {
    return IssueResolutionKind.Resolved;
  }
  if (kind === SynthesisKind.Blocking) {
    return IssueResolutionKind.Blocking;
  }
  return IssueResolutionKind.NonBlocking;
}

export async function findIssueByFlag(loopDir: string, flag: string): Promise<IssueRecord | undefined> {
  const issues = await listIssues(loopDir);
  return issues.find((issue) => issue.flag === flag);
}

export async function cancelIssues(loopDir: string, issueIds?: string[], force = false, options?: StoreWriteOptions): Promise<IssueRecord[]> {
  return afterMutation(enqueueStateWrite(loopDir, async () => {
    const issues = await listIssues(loopDir);
    const wanted = issueIds ? new Set(issueIds) : undefined;
    const updated: IssueRecord[] = [];
    for (const issue of issues) {
      if (wanted && !wanted.has(issue.id)) {
        updated.push(issue);
        continue;
      }
      if (isTerminalIssueState(issue.state) && !force) {
        updated.push(issue);
        continue;
      }
      const machine = force
        ? { ...issue.machine, state: IssueState.Cancelled }
        : transitionIssue(issue.machine, { kind: IssueEventKind.LoopEnded });
      updated.push(await writeIssueFiles(loopDir, { ...issue, state: machine.state, machine }));
    }
    await writeIssueRegistry(loopDir);
    return updated;
  }), options);
}

export async function cancelOpenIssues(loopDir: string, options?: StoreWriteOptions): Promise<IssueRecord[]> {
  return cancelIssues(loopDir, undefined, false, options);
}

export function issueToOpenQuestion(issue: IssueRecord): OpenQuestion | undefined {
  if (issue.state !== IssueState.NonBlocking && issue.state !== IssueState.Blocking) {
    return undefined;
  }
  const synthesis = issue.synthesis;
  return {
    issueId: issue.id,
    flag: issue.flag,
    state: issue.state,
    summary: synthesis?.reason || issue.responses.at(-1)?.reason || issue.dispute.workerPosition,
    blockReason: synthesis?.blockReason,
    userQuestion: synthesis?.userQuestion,
    files: {
      issue: issue.files.issue,
      synthesis: issue.files.synthesis,
      analyses: issue.files.analyses,
    },
  };
}

export function recommendedResolutionToIssueState(resolution: RecommendedResolution): IssueState {
  if (resolution === RecommendedResolution.Resolved) {
    return IssueState.Resolved;
  }
  if (resolution === RecommendedResolution.AskUser) {
    return IssueState.Blocking;
  }
  return IssueState.NonBlocking;
}
