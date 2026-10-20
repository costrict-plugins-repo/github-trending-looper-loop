export const RUN_STATUSES = new Set(["starting", "worker-running", "worker-logging", "observers-running", "analyzing-dispute", "deciding", "cancelling"]);
export const OK_STATUSES = new Set(["done"]);
export const WARN_STATUSES = new Set(["max-iter-reached", "cancelled", "needs-user"]);
export const BAD_STATUSES = new Set(["aborted", "failed"]);

export function toneFor(status) {
  if (RUN_STATUSES.has(status)) return "run";
  if (OK_STATUSES.has(status)) return "ok";
  if (WARN_STATUSES.has(status)) return "warn";
  if (BAD_STATUSES.has(status)) return "bad";
  return "";
}

export function prettyStatus(status) {
  return (status || "idle").replace(/-/g, " ");
}

export function isTerminal(status) {
  return OK_STATUSES.has(status) || WARN_STATUSES.has(status) || BAD_STATUSES.has(status);
}

export function progressPercent(state) {
  if (OK_STATUSES.has(state.status)) return 100;
  const iter = state.iter ?? 0;
  const max = state.maxIter ?? 0;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (iter / max) * 100));
}
