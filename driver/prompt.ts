import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { globalStatePath } from "./state";
import { iterDir } from "./paths";
import { ObserverVerdict, WorkerSignal, type FinalDecision } from "./runners/types";

async function readOptional(file: string, fallback = ""): Promise<string> {
  if (!existsSync(file)) {
    return fallback;
  }
  return readFile(file, "utf8");
}

type PreviousVerdicts = {
  worker?: WorkerSignal;
  merged?: ObserverVerdict;
  final?: FinalDecision;
  observers?: { markdownPath?: string; verdict?: ObserverVerdict; error?: string }[];
};

async function readPreviousVerdicts(previousDir: string | undefined): Promise<PreviousVerdicts | undefined> {
  if (!previousDir) {
    return undefined;
  }
  const raw = await readOptional(path.join(previousDir, "verdicts.json"));
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as PreviousVerdicts;
  } catch {
    // Verdicts file may be partially written or corrupt; treat as absent.
    return undefined;
  }
}

async function readObserverNotes(verdicts: PreviousVerdicts | undefined): Promise<string> {
  const observers = verdicts?.observers ?? [];
  const notes: string[] = [];
  for (const observer of observers) {
    if (!observer.markdownPath) {
      continue;
    }
    const text = (await readOptional(observer.markdownPath)).trim();
    if (text) {
      notes.push(`- ${observer.markdownPath}\n${text}`);
    }
  }
  return notes.join("\n\n");
}

async function buildDisagreementGuidance(previousDir: string | undefined): Promise<string> {
  const verdicts = await readPreviousVerdicts(previousDir);
  const notes = await readObserverNotes(verdicts);
  if (verdicts?.worker === WorkerSignal.Done && verdicts.merged === ObserverVerdict.Continue) {
    return `
Previous iteration disagreement:
Last iter you claimed completion but observers disagreed. Their concerns:
${notes || "- Observer notes were unavailable; inspect the previous iteration verdicts and logs."}

Address those concerns before claiming completion again.`;
  }
  if (verdicts?.worker === WorkerSignal.None && verdicts.merged === ObserverVerdict.Done) {
    return `
Previous iteration disagreement:
Last iter the observer thought the goal looked complete, but you did not claim done. Re-evaluate the goal. If you agree, emit COMPLETION_PROMISE_SATISFIED: CONFIRMED at the end of the logging turn. Observer notes:
${notes || "- Observer notes were unavailable; inspect the previous iteration verdicts and logs."}`;
  }
  return "";
}

export type WorkerPromptInput = {
  loopDir: string;
  iter: number;
  maxIter: number;
  task: string;
};

export async function buildWorkerPrompt(input: WorkerPromptInput): Promise<string> {
  const previous = input.iter - 1;
  const state = await readOptional(globalStatePath(input.loopDir), `# Global State\n\nGoal: ${input.task}\n\nNothing has been completed yet.\n`);
  const previousDir = previous > 0 ? iterDir(input.loopDir, previous) : undefined;
  const disagreementGuidance = await buildDisagreementGuidance(previousDir);

  return `You are iteration ${input.iter} of ${input.maxIter}. ${input.maxIter - input.iter} iterations remain after this one.

Goal:
${input.task}

Current global state:
${state}

File-system layout:
- ${globalStatePath(input.loopDir)}: current snapshot; you will overwrite it in the log turn.
- ${input.loopDir}/iter-K/worker.log.md: past worker-authored markdown logs.
- ${input.loopDir}/iter-K/observer-iter-K-*.md: past observer reviews.
- ${input.loopDir}/iter-K/worker.turn*.jsonl: raw driver-captured streams; use only for debugging.

Reading priority:
- PRIORITY READ: ${previousDir ? path.join(previousDir, "worker.log.md") : "none yet"} and ${previousDir ? path.join(previousDir, `observer-iter-${previous}-*.md`) : "none yet"}.
- REFERENCE: older iterations only if global-state.md references them or if you need deep history.
${disagreementGuidance}

Do real work now. Edit files, run tests, and debug. Do not write loop completion marker files. Do not spend this turn writing the loop log unless it helps your work.`;
}

export type LogPromptInput = {
  loopDir: string;
  iter: number;
};

export function buildWorkerLogPrompt(input: LogPromptInput): string {
  const dir = iterDir(input.loopDir, input.iter);
  return `Now perform the logging turn for iteration ${input.iter}.

Required file writes:
1. Write ${path.join(dir, "worker.log.md")} with detailed progress notes from this iteration. Near the top, include a fenced looperloop-summary block with 1-2 short sentences describing what you did this iteration:
   \`\`\`looperloop-summary
   <1-2 short sentences for the activity feed>
   \`\`\`
2. Overwrite ${globalStatePath(input.loopDir)} with the current state: what's done, what's left, and references to relevant worker.log.md files.

Optional dispute file:
- If you disagree with a reviewer flag and believe it is out of scope, non-applicable, needs a user decision, or should be fixed separately, write ${path.join(dir, "disputed-flags.md")}.
- Keep it structured: flag, raised_in, worker_position, proposed_resolution, and evidence.

Completion signaling:
- If and only if the goal is genuinely satisfied, end your response with this exact line:
COMPLETION_PROMISE_SATISFIED: CONFIRMED
- If you are truly stuck after good-faith effort, end your response with this prefix and a one-line reason:
WORKER_SELF_ABORT: <one-line reason>

Do not emit either sentinel as an example, code block, or documentation.`;
}

export type ObserverPromptInput = {
  loopDir: string;
  iter: number;
  task: string;
  stopCondition: string;
  workerSignal: WorkerSignal;
  issueContext?: string;
};

export async function buildObserverPrompt(input: ObserverPromptInput): Promise<string> {
  const currentIterDir = iterDir(input.loopDir, input.iter);
  const global = await readOptional(globalStatePath(input.loopDir), "# Global State\n\nNo global state was written.\n");
  const workerLogPath = path.join(currentIterDir, "worker.log.md");
  const workerLog = await readOptional(workerLogPath, `Worker log missing at ${workerLogPath}.\n`);
  const disputedFlagsPath = path.join(currentIterDir, "disputed-flags.md");
  const disputedFlags = await readOptional(disputedFlagsPath);

  let preface = "";
  if (input.workerSignal === WorkerSignal.Done) {
    preface = "THE AGENT CLAIMS THE GOAL IS SATISFIED. Review and verify the claim. Be skeptical. Only output OBSERVER_VERDICT: done if you can verify it from files, tests, or behavior.\n\n";
  } else if (input.workerSignal === WorkerSignal.Abort) {
    preface = "THE AGENT WANTS TO ABORT. Decide whether this is genuinely stuck or premature giving up.\n\n";
  }

  return `${preface}You are an external observer for looperloop iteration ${input.iter}.
Do not ask for more context. The complete context you need is included below.
Do not modify project files. Return the review in your final answer.

Original task:
${input.task}

Stop condition:
${input.stopCondition}

Current global state:
${global}

Worker log (${workerLogPath}):
${workerLog}

Worker disputed flags (${disputedFlagsPath}):
${disputedFlags?.trim() || "No disputed flags were written this iteration."}

Merged issue-branch context:
${input.issueContext?.trim() || "No issue-branch synthesis is available for this review."}

Raw worker streams, for debugging only:
- ${path.join(currentIterDir, "worker.turn1.jsonl")}
- ${path.join(currentIterDir, "worker.turn2.jsonl")}

Write a concise but complete review.
Near the top of your review, include a fenced looperloop-summary block with 1-2 short sentences describing what you checked and what you concluded:
\`\`\`looperloop-summary
<1-2 short sentences for the activity feed>
\`\`\`

Your final response must end with exactly one own-line verdict:
OBSERVER_VERDICT: done
OBSERVER_VERDICT: continue
OBSERVER_VERDICT: abort

If you need to escalate a disputed flag, include a fenced block before the verdict:
\`\`\`looperloop-dispute-responses
- flag: "short flag title"
  observer_position: "what you think about the worker position"
  escalate: true
  blocking: false
  reason: "why this needs a side branch or user visibility"
  block_reason: ""
  recommended_resolution: carry_to_result
\`\`\`

Escalation and blocking policy:
- Use escalate: true when a disputed point needs explicit tracking, side-branch analysis, or user visibility.
- Use blocking: true only when the current task cannot continue safely or meaningfully without a user decision or missing required input.
- Blocking is reserved for hard blockers: required unavailable inputs or access, irreversible or risky changes, mutually incompatible product/API choices, or inability to verify a required outcome.
- Do not use blocking: true for ordinary engineering uncertainty, preferences, reversible choices, partial-scope issues, or anything that can be carried to the final result without major rework.
- If useful work can continue, set blocking: false.
- If a safe reversible default exists, set blocking: false and recommend that default.
- If the issue should be visible to the user but does not stop the work, set blocking: false and recommended_resolution: carry_to_result.
- If blocking is true, block_reason must be non-empty and must explain why continuing would be unsafe or meaningless.`;
}
