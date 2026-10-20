import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readBranchGraph, type BranchGraph } from "../../driver/branches/graph";
import { issueToOpenQuestion, listIssues, type OpenQuestion } from "../../driver/dispute/store";
import { type LoopResult } from "../../driver/notify";
import { globalStatePath, readJson, resultPath, statePath, type LoopConfig, type LoopState } from "../../driver/state";
import { resolveLoopDir, type StatusInput } from "./status";

export type ResultInput = StatusInput;

export type IterationFiles = {
  iter: number;
  workerLog?: string;
  verdicts?: string;
  observerReviews: string[];
  raw: string[];
};

export type ResultOutput = {
  loop_id: string;
  outcome: string;
  status: string;
  iterationsUsed: number;
  maxIter: number;
  statusUrl?: string;
  resultFile?: string;
  globalStateFile: string;
  entrypoint: {
    kind: "global-state";
    file: string;
    text: string;
  };
  userFacingResult: string;
  openQuestions: OpenQuestion[];
  branchGraph: BranchGraph;
  files: {
    config?: string;
    state: string;
    result?: string;
    globalState: string;
    iterations: IterationFiles[];
    issues: string[];
  };
  activity: LoopState["activity"];
  instruction: string;
};

const RESULT_INSTRUCTION =
  "Present userFacingResult as the final result first. If outcome is needs-user, lead with openQuestions[*].userQuestion for blocking issues. Use branchGraph when you need to explain parallel side work or render branch/canvas views. If the user asks for details, read files.iterations[*].workerLog for progress notes, observerReviews/verdicts for validation, and openQuestions[*].files for dispute context. Raw JSONL/log files are debugging artifacts only.";

async function readOptional(file: string): Promise<string | undefined> {
  if (!existsSync(file)) {
    return undefined;
  }
  return readFile(file, "utf8");
}

async function iterationFiles(loopDir: string): Promise<IterationFiles[]> {
  const entries = await readdir(loopDir, { withFileTypes: true });
  const iters = entries
    .filter((entry) => entry.isDirectory() && /^iter-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("iter-".length)))
    .sort((a, b) => a - b);
  const result: IterationFiles[] = [];
  for (const iter of iters) {
    const iterPath = path.join(loopDir, `iter-${iter}`);
    const files = await readdir(iterPath);
    result.push({
      iter,
      workerLog: existsSync(path.join(iterPath, "worker.log.md")) ? path.join(iterPath, "worker.log.md") : undefined,
      verdicts: existsSync(path.join(iterPath, "verdicts.json")) ? path.join(iterPath, "verdicts.json") : undefined,
      observerReviews: files
        .filter((file) => /^observer-.*\.md$/.test(file) && !file.endsWith(".prompt.md"))
        .map((file) => path.join(iterPath, file)),
      raw: files
        .filter((file) => file.endsWith(".jsonl") || file.endsWith(".raw.log") || file.endsWith(".stderr.log"))
        .map((file) => path.join(iterPath, file)),
    });
  }
  return result;
}

function formatOpenQuestions(openQuestions: OpenQuestion[]): string {
  if (!openQuestions.length) {
    return "";
  }
  const lines = openQuestions.map((question) => {
    const status = question.state === "blocking" ? "Blocking" : "Non-blocking";
    const blockReason = question.blockReason ? `\n  Block reason: ${question.blockReason}` : "";
    const userQuestion = question.userQuestion ? `\n  User question: ${question.userQuestion}` : "";
    return `- ${question.flag} (${status})\n  Summary: ${question.summary}${blockReason}${userQuestion}`;
  });
  return `\n\nOpen questions:\n${lines.join("\n")}`;
}

function needsUserLead(outcome: string, openQuestions: OpenQuestion[]): string {
  if (outcome !== "needs-user") {
    return "";
  }
  const blocking = openQuestions.find((question) => question.state === "blocking" && question.userQuestion);
  return blocking ? `Needs user decision:\n${blocking.userQuestion}\n\n` : "";
}

export async function looperloopResult(input: ResultInput): Promise<ResultOutput> {
  const dir = await resolveLoopDir(input);
  const stateFile = statePath(dir);
  if (!existsSync(stateFile)) {
    throw new Error(`No state found for ${input.loop_id}`);
  }
  const state = await readJson<LoopState>(stateFile);
  const configFile = path.join(dir, "config.json");
  const config = existsSync(configFile) ? await readJson<LoopConfig>(configFile) : undefined;
  const resultFile = resultPath(dir);
  const storedResult = existsSync(resultFile) ? await readJson<LoopResult>(resultFile) : undefined;
  const globalFile = globalStatePath(dir);
  const globalText = ((await readOptional(globalFile)) ?? "No global-state.md was written.").trim();
  const outcome = storedResult?.outcome ?? state.status;
  const issues = await listIssues(dir);
  const openQuestions = issues.map(issueToOpenQuestion).filter((question): question is OpenQuestion => Boolean(question));
  const branchGraph = await readBranchGraph(dir);
  const baseUserFacingResult = state.resultSummary ? `${state.resultSummary}\n\n${globalText}` : globalText;
  const userFacingResult = `${needsUserLead(outcome, openQuestions)}${baseUserFacingResult}${formatOpenQuestions(openQuestions)}`;

  return {
    loop_id: state.loopId,
    outcome,
    status: state.status,
    iterationsUsed: state.iter,
    maxIter: state.maxIter,
    statusUrl: state.statusUrl,
    resultFile: existsSync(resultFile) ? resultFile : undefined,
    globalStateFile: globalFile,
    entrypoint: {
      kind: "global-state",
      file: globalFile,
      text: globalText,
    },
    userFacingResult,
    openQuestions,
    branchGraph,
    files: {
      config: config ? configFile : undefined,
      state: stateFile,
      result: existsSync(resultFile) ? resultFile : undefined,
      globalState: globalFile,
      iterations: await iterationFiles(dir),
      issues: issues.map((issue) => issue.files.dir),
    },
    activity: state.activity ?? [],
    instruction: RESULT_INSTRUCTION,
  };
}
