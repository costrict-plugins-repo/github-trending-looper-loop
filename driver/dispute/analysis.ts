import { readFile } from "node:fs/promises";
import path from "node:path";
import { runParallelBranch } from "../branches/parallel";
import { runCapturedTurn } from "../capture";
import { LoopStatus, globalStatePath, updateState } from "../state";
import { safeModelName } from "../paths";
import { backoffMs, makeAbortContext, makeRunnerContext, sleep, timeoutMs } from "../run-helpers";
import { getRunner, type RunnerRegistry } from "../runners/registry";
import {
  AgentRole,
  RunnerOutputFormat,
  TurnKind,
  TurnOutcome,
  type ModelRef,
  type TurnRequest,
} from "../runners/types";
import { SynthesisKind, parseSynthesisMarkdown, type SynthesisVerdict } from "./protocol";
import { issueDir, readIssue, startIssueAnalyses, writeIssueAnalysis, writeIssueAnalysisFailure, writeIssueSynthesis, type IssueAnalysisInput, type IssueRecord } from "./store";

export type RunIssueBranchInput = {
  loopDir: string;
  workspaceDir: string;
  task: string;
  stopCondition: string;
  worker: ModelRef;
  observers: ModelRef[];
  issueId: string;
  abortSignal?: AbortSignal;
  onStateChange?: () => Promise<void>;
};

type AnalysisSpec = {
  id: string;
  role: "worker" | "reviewer";
  model: ModelRef;
  index: number;
};

function analysisSpecs(worker: ModelRef, observers: ModelRef[]): AnalysisSpec[] {
  return [
    { id: "worker-0", role: "worker", model: worker, index: 0 },
    ...observers.map((model, index) => ({ id: `reviewer-${index}`, role: "reviewer" as const, model, index })),
  ];
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function analysisName(spec: AnalysisSpec): string {
  return `${spec.role}-${spec.model.provider}-${safeModelName(spec.model.model)}-${spec.index}`;
}

function analysisInput(spec: AnalysisSpec): IssueAnalysisInput {
  return {
    name: analysisName(spec),
    specId: spec.id,
    role: spec.role,
    model: spec.model,
    modelIndex: spec.index,
  };
}

function analysisPrompt(input: RunIssueBranchInput, issue: IssueRecord, spec: AnalysisSpec, globalState: string): string {
  return `You are analyzing a LooperLoop disputed issue as the ${spec.role} perspective.
Do not modify project files. Write a concise analysis only.

Original task:
${input.task}

Stop condition:
${input.stopCondition}

Current global state:
${globalState}

Issue:
- id: ${issue.id}
- flag: ${issue.flag}
- raised in iteration: ${issue.raisedInIter}
- worker position: ${issue.dispute.workerPosition}
- proposed resolution: ${issue.dispute.proposedResolution}
- evidence: ${issue.dispute.evidence.join("; ") || "none listed"}

Your job:
- Decide whether this point is resolved, non-blocking, or truly blocking.
- Explain what evidence supports your view.
- If it is blocking, state the exact user decision needed.`;
}

function synthesisPrompt(input: RunIssueBranchInput, issue: IssueRecord, analyses: string[]): string {
  return `You are the synthesis reviewer for a LooperLoop issue branch.
Do not modify project files. Read the issue and the parallel analyses, then return one synthesis verdict.

Original task:
${input.task}

Stop condition:
${input.stopCondition}

Issue:
- id: ${issue.id}
- flag: ${issue.flag}
- worker position: ${issue.dispute.workerPosition}
- proposed resolution: ${issue.dispute.proposedResolution}

Analyses:
${analyses.map((text, index) => `## Analysis ${index + 1}\n${text}`).join("\n\n")}

Return a concise explanation and include this fenced block:
\`\`\`looperloop-synthesis
issue_id: ${issue.id}
kind: non-blocking
reason: "short reason"
block_reason: ""
user_question: ""
recommended_instruction_for_worker: ""
\`\`\`

Allowed kind values: resolved, non-blocking, blocking.
The observer's blocking request is not final; independently decide whether the issue is truly blocking.
Return kind: blocking only if all are true:
- The missing decision or input is required for the user's requested outcome.
- The worker cannot continue meaningful safe work around it.
- A wrong guess could cause meaningful rework, a broken public contract, failed required integration, data/security/privacy/billing risk, or impossible verification.
- The question cannot reasonably be carried as a non-blocking result note.
Otherwise return kind: non-blocking or kind: resolved.
If kind is blocking, block_reason must be non-empty and user_question should ask the exact decision needed.`;
}

async function runAnalysisTurn(
  registry: RunnerRegistry,
  input: RunIssueBranchInput,
  issue: IssueRecord,
  spec: AnalysisSpec,
  globalState: string,
): Promise<{ name: string; ok: boolean; text: string }> {
  const runner = getRunner(registry, spec.model.provider);
  const name = analysisName(spec);
  const rawPath = path.join(issueDir(input.loopDir, issue.id), `analysis-${name}.${runner.outputFormat === RunnerOutputFormat.StreamJson ? "raw.jsonl" : "raw.log"}`);
  const stderrPath = path.join(issueDir(input.loopDir, issue.id), `analysis-${name}.stderr.log`);
  const request: TurnRequest = {
    role: AgentRole.Observer,
    kind: TurnKind.Observe,
    model: spec.model,
    prompt: analysisPrompt(input, issue, spec, globalState),
    timeoutMs: timeoutMs("LOOPERLOOP_ISSUE_ANALYSIS_TIMEOUT_MS", 10 * 60 * 1000),
    permissions: { skip: true },
  };

  let lastText = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const abort = makeIssueAbortContext(input.loopDir, input.abortSignal);
    const captured = await runCapturedTurn({
      runner,
      request,
      context: makeRunnerContext({
        loopDir: input.loopDir,
        workspaceDir: input.workspaceDir,
        abortSignal: abort.controller.signal,
      }),
      stdoutPath: rawPath,
      stderrPath,
      resume: false,
    }).finally(abort.stop);
    lastText = captured.result.finalAssistantText;
    if (captured.result.outcome === TurnOutcome.Completed) {
      return { name, ok: true, text: lastText || "No analysis text returned." };
    }
    if (attempt < 2) {
      await sleep(backoffMs(attempt));
    }
  }
  return { name, ok: false, text: lastText || "Analysis failed." };
}

async function runSynthesisTurn(
  registry: RunnerRegistry,
  input: RunIssueBranchInput,
  issue: IssueRecord,
  analyses: string[],
): Promise<IssueRecord> {
  const model = input.observers[0] ?? input.worker;
  const runner = getRunner(registry, model.provider);
  const rawPath = path.join(issueDir(input.loopDir, issue.id), `synthesis-${safeModelName(model.model)}.${runner.outputFormat === RunnerOutputFormat.StreamJson ? "raw.jsonl" : "raw.log"}`);
  const stderrPath = path.join(issueDir(input.loopDir, issue.id), `synthesis-${safeModelName(model.model)}.stderr.log`);
  const request: TurnRequest = {
    role: AgentRole.Observer,
    kind: TurnKind.Observe,
    model,
    prompt: synthesisPrompt(input, issue, analyses),
    timeoutMs: timeoutMs("LOOPERLOOP_ISSUE_SYNTHESIS_TIMEOUT_MS", 10 * 60 * 1000),
    permissions: { skip: true },
  };

  const abort = makeIssueAbortContext(input.loopDir, input.abortSignal);
  const captured = await runCapturedTurn({
    runner,
    request,
    context: makeRunnerContext({
      loopDir: input.loopDir,
      workspaceDir: input.workspaceDir,
      abortSignal: abort.controller.signal,
    }),
    stdoutPath: rawPath,
    stderrPath,
    resume: false,
  }).finally(abort.stop);
  const parsed = parseSynthesisMarkdown(captured.result.finalAssistantText);
  const fallback: SynthesisVerdict = {
    issueId: issue.id,
    kind: SynthesisKind.NonBlocking,
    reason: captured.result.error || "Synthesis did not return a usable verdict; carrying issue to result.",
  };
  return writeIssueSynthesis(input.loopDir, issue.id, captured.result.finalAssistantText || fallback.reason, parsed ?? fallback, { onMutate: input.onStateChange });
}

function makeIssueAbortContext(loopDir: string, external?: AbortSignal) {
  const abort = makeAbortContext(loopDir);
  const onAbort = () => abort.controller.abort();
  if (external?.aborted) {
    abort.controller.abort();
  }
  external?.addEventListener("abort", onAbort, { once: true });
  return {
    controller: abort.controller,
    stop: () => {
      external?.removeEventListener("abort", onAbort);
      abort.stop();
    },
  };
}

export async function runIssueBranch(registry: RunnerRegistry, input: RunIssueBranchInput): Promise<IssueRecord> {
  await updateState(input.loopDir, { status: LoopStatus.AnalyzingDispute, currentActor: `issue.${input.issueId}` });
  await input.onStateChange?.();
  const specs = analysisSpecs(input.worker, input.observers);
  const issue = await startIssueAnalyses(input.loopDir, input.issueId, specs.length, { onMutate: input.onStateChange });
  const globalState = await readOptional(globalStatePath(input.loopDir));
  const analyses = await runParallelBranch({
    nodes: specs,
    runNode: (spec) => runAnalysisTurn(registry, input, issue, spec, globalState),
    onNodeCompleted: async (spec, text) => {
      await writeIssueAnalysis(input.loopDir, issue.id, analysisInput(spec), text, { onMutate: input.onStateChange });
    },
    onNodeFailed: async (spec, text) => {
      await writeIssueAnalysisFailure(input.loopDir, issue.id, analysisInput(spec), text, { onMutate: input.onStateChange });
    },
  });
  const latestIssue = await readIssue(input.loopDir, input.issueId);
  const successfulAnalyses = analyses.successful.map((analysis) => analysis.text);
  if (!successfulAnalyses.length) {
    return latestIssue;
  }
  return runSynthesisTurn(registry, input, latestIssue, successfulAnalyses);
}
