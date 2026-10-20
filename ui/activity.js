import { isTerminal } from "./state-view.js";

export function humanActivityStatus(status) {
  if (status === "done") return "done";
  if (status === "failed") return "needs attention";
  if (status === "running") return "running";
  return status || "-";
}

export function liveActivity(state) {
  if (isTerminal(state.status)) return undefined;
  const iter = state.iter ?? 0;
  if (state.status === "cancelling" || state.currentActor === "cancelling") {
    return { iter, status: "running", title: "Cancellation requested", summary: "LooperLoop is stopping the active agent and saving the run state." };
  }
  if (state.currentActor === "worker.turn1") {
    return { iter, status: "running", title: "Worker is making changes", summary: "The agent is working in the project." };
  }
  if (state.currentActor === "worker.turn2") {
    return { iter, status: "running", title: "Worker is writing notes", summary: "The agent is updating worker.log.md and global-state.md." };
  }
  if (state.currentActor === "observers") {
    return { iter, status: "running", title: "Reviewers are checking the work", summary: "Reviewer agents are reading the result and deciding whether to continue." };
  }
  if (state.status === "analyzing-dispute" || String(state.currentActor || "").startsWith("issue.")) {
    return { iter, status: "running", title: "Reviewing an open question", summary: "Side-branch agents are checking whether a disputed point blocks the work." };
  }
  if (state.currentActor === "driver") {
    return { iter, status: "running", title: "LooperLoop is deciding next step", summary: "The driver is merging worker and reviewer signals." };
  }
  if (state.status === "starting") {
    return { iter, status: "running", title: "Loop is starting", summary: "Preparing the run directory and status window." };
  }
  return undefined;
}

export function activityItem(entry, doc = document) {
  const item = doc.createElement("li");
  if (entry.live) item.dataset.live = "true";
  const title = doc.createElement("div");
  title.className = "activity-title";
  const text = doc.createElement("span");
  text.textContent = entry.title || "Step finished";
  const stage = doc.createElement("span");
  stage.className = "activity-stage";
  stage.textContent = `iteration ${entry.iter ?? "-"} - ${humanActivityStatus(entry.status)}`;
  title.append(text);
  item.append(title);
  const detail = doc.createElement("div");
  detail.className = "activity-detail";
  const summary = doc.createElement("span");
  summary.className = "activity-summary";
  summary.textContent = entry.summary || "";
  detail.append(summary, stage);
  item.append(detail);
  return item;
}

export function renderActivity(nodes, state, activityHistory) {
  const live = liveActivity(state);
  const source = activityHistory.length ? activityHistory : state.activity ?? [];
  const activity = [...source.slice(-12).reverse()];
  if (live) activity.unshift({ ...live, live: true });
  nodes.activity.replaceChildren(...activity.map((entry) => activityItem(entry)));
  nodes.activityCard.hidden = activity.length === 0;
}
