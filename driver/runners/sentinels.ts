import { ObserverVerdict, WorkerSignal } from "./types";

const completionLine = "COMPLETION_PROMISE_SATISFIED: CONFIRMED";
const workerAbortPrefix = "WORKER_SELF_ABORT:";
const observerPrefix = "OBSERVER_VERDICT:";

function tailLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-5);
}

export function parseWorkerSignal(text: string): { signal: WorkerSignal; reason?: string } {
  const lines = tailLines(text);
  const last = lines.at(-1) ?? "";
  if (last === completionLine) {
    return { signal: WorkerSignal.Done };
  }
  if (last.startsWith(workerAbortPrefix)) {
    return { signal: WorkerSignal.Abort, reason: last.slice(workerAbortPrefix.length).trim() };
  }
  return { signal: WorkerSignal.None };
}

export function parseObserverVerdict(text: string): ObserverVerdict {
  const lines = tailLines(text);
  const last = lines.at(-1) ?? "";
  if (!last.startsWith(observerPrefix)) {
    return ObserverVerdict.Failed;
  }
  const verdict = last.slice(observerPrefix.length).trim().toLowerCase();
  for (const value of Object.values(ObserverVerdict)) {
    if (value === verdict && value !== ObserverVerdict.Failed) {
      return value;
    }
  }
  return ObserverVerdict.Failed;
}
