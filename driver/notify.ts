import { writeFile } from "node:fs/promises";
import { loopDir } from "./paths";
import { beep, notify } from "./platform";
import {
  NotificationEvent,
  NotificationProvider,
  readGlobalNotifyConfig,
  type GlobalNotifyConfig,
  type NotificationChannel,
} from "./notify-config";
import { ActivityStage, ActivityStatus, NotifyKind, completePath, resultPath, type LoopConfig, type LoopState } from "./state";

export type LoopResult = {
  loopId: string;
  outcome: string;
  reason?: string;
  completedAt: string;
  state: LoopState;
  config: LoopConfig;
};

export async function writeCompletion(dir: string, result: LoopResult): Promise<void> {
  await writeFile(resultPath(dir), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(completePath(dir), `${result.outcome}\n`, "utf8");
}

export type CompletionNotifier = {
  beep: typeof beep;
  notify: typeof notify;
  sendRemote?: RemoteNotificationSender;
  readGlobalConfig?: () => Promise<GlobalNotifyConfig>;
};

export type LoopStartedNotification = {
  loopId: string;
  state: LoopState;
  config: LoopConfig;
};

export type RemoteNotificationSender = (channel: NotificationChannel, message: string) => Promise<void>;

export type SlackUserResolver = (params: { botToken: string; email?: string; handle?: string }) => Promise<string>;

export async function notifyCompletion(result: LoopResult, notifier: CompletionNotifier = { beep, notify }): Promise<void> {
  const resultFilePath = resultPath(loopDir(result.state.workspaceDir, result.loopId));
  const message = finishMessage(result, resultFilePath);
  if (result.config.notify.includes(NotifyKind.Sound)) {
    await notifier.beep();
  }
  if (result.config.notify.includes(NotifyKind.Toast)) {
    await notifier.notify({ title: "looperloop complete", body: message });
  }
  if (result.config.notify.includes(NotifyKind.Global)) {
    await notifyGlobalChannels(NotificationEvent.LoopFinished, message, notifier);
  }
  console.log(message);
}

export async function notifyLoopStarted(started: LoopStartedNotification, notifier: CompletionNotifier = { beep, notify }): Promise<void> {
  if (!started.config.notify.includes(NotifyKind.Global)) {
    return;
  }
  await notifyGlobalChannels(NotificationEvent.LoopStarted, startMessage(started), notifier);
}

async function notifyGlobalChannels(
  event: NotificationEvent,
  message: string,
  notifier: CompletionNotifier,
): Promise<void> {
  const config = await (notifier.readGlobalConfig?.() ?? readGlobalNotifyConfig());
  if (!config.events[event]) {
    return;
  }
  const sender = notifier.sendRemote ?? sendRemoteNotification;
  const failures: string[] = [];
  for (const channel of config.channels.filter((candidate) => candidate.enabled)) {
    try {
      await sender(channel, message);
    } catch (error) {
      failures.push(`${channel.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    throw new Error(failures.join("; "));
  }
}

function startMessage({ loopId, state, config }: LoopStartedNotification): string {
  const reviewers = config.observers.map((observer) => observer.model).join(" + ");
  const status = state.statusUrl ? `\nStatus: ${state.statusUrl}` : "";
  return [
    `LooperLoop started: ${loopId}`,
    `Worker: ${config.worker.model} | Reviewers: ${reviewers}`,
    `Max iterations: ${config.maxIter}`,
    `Task: ${oneLine(config.task, 160)}${status}`,
  ].join("\n");
}

function finishMessage(result: LoopResult, resultFilePath: string): string {
  const summary = result.state.resultSummary ?? `Finished with ${result.outcome}.`;
  const tldr = notificationTldr(result.state);
  const status = result.state.statusUrl ? `\nStatus: ${result.state.statusUrl}` : "";
  const lines = [
    `LooperLoop finished: ${result.loopId}`,
    summary,
  ];
  if (tldr) {
    lines.push(`TLDR: ${tldr}`);
  }
  lines.push(
    `Outcome: ${result.outcome}`,
    `Result: ${resultFilePath}${status}`,
  );
  return lines.join("\n");
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function notificationTldr(state: LoopState): string | undefined {
  const entry = [...(state.activity ?? [])]
    .reverse()
    .find((candidate) =>
      candidate.stage === ActivityStage.WorkerLog &&
      candidate.status === ActivityStatus.Done &&
      candidate.summary &&
      candidate.summary.trim().length > 0
    );
  return entry?.summary ? oneLine(entry.summary, 220) : undefined;
}

export async function sendRemoteNotification(channel: NotificationChannel, message: string): Promise<void> {
  if (channel.provider === NotificationProvider.Telegram) {
    await postJson(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
      chat_id: channel.chatId,
      text: message,
      disable_web_page_preview: true,
    });
    return;
  }
  if ("webhookUrl" in channel) {
    await postJson(channel.webhookUrl, { text: message });
    return;
  }
  const slackChannel = await resolveSlackBotDmChannel(channel);
  await postSlackApi(channel.botToken, "https://slack.com/api/chat.postMessage", {
    channel: slackChannel,
    text: message,
  });
}

async function resolveSlackBotDmChannel(channel: Exclude<NotificationChannel, { webhookUrl: string } | { provider: NotificationProvider.Telegram }>): Promise<string> {
  if (channel.dmChannelId) {
    return channel.dmChannelId;
  }
  if (!channel.userId) {
    throw new Error("Slack bot DM channel requires userId or dmChannelId.");
  }
  if (!channel.openDm) {
    return channel.userId;
  }
  const opened = await postSlackApi<{ channel?: { id?: string } }>(channel.botToken, "https://slack.com/api/conversations.open", {
    users: channel.userId,
  });
  const channelId = opened.channel?.id;
  if (!channelId) {
    throw new Error("Slack conversations.open did not return a channel id.");
  }
  return channelId;
}

export async function resolveSlackUserId({ botToken, email, handle }: { botToken: string; email?: string; handle?: string }): Promise<string> {
  if (email) {
    const found = await slackApiGet<{ user?: { id?: string } }>(botToken, "https://slack.com/api/users.lookupByEmail", { email });
    const userId = found.user?.id;
    if (!userId) {
      throw new Error(`Slack users.lookupByEmail did not return a user id for ${email}.`);
    }
    return userId;
  }
  if (handle) {
    return resolveSlackUserIdByHandle(botToken, handle);
  }
  throw new Error("Slack user lookup requires email or handle.");
}

async function resolveSlackUserIdByHandle(botToken: string, handle: string): Promise<string> {
  const wanted = normalizeSlackHandle(handle);
  const matches: Array<{ id: string; label: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await slackApiGet<{
      members?: Array<{
        id?: string;
        name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: {
          display_name?: string;
          real_name?: string;
        };
      }>;
      response_metadata?: { next_cursor?: string };
    }>(botToken, "https://slack.com/api/users.list", cursor ? { cursor } : {});
    for (const member of page.members ?? []) {
      if (!member.id || member.deleted || member.is_bot) {
        continue;
      }
      const names = [member.name, member.profile?.display_name, member.profile?.real_name].filter(Boolean) as string[];
      if (names.some((name) => normalizeSlackHandle(name) === wanted)) {
        matches.push({ id: member.id, label: names.join(" / ") });
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (!matches.length) {
    throw new Error(`No Slack user matched ${handle}. Try email or exact user id.`);
  }
  throw new Error(`Slack user lookup for ${handle} matched multiple users: ${matches.map((match) => `${match.id} (${match.label})`).join(", ")}. Use email or userId.`);
}

function normalizeSlackHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Notification request failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function postSlackApi<T extends Record<string, unknown>>(botToken: string, url: string, body: unknown): Promise<T> {
  const json = await postJson(url, body, { authorization: `Bearer ${botToken}` }) as T & { ok?: boolean; error?: string };
  if (!json.ok) {
    throw new Error(`Slack API request failed: ${json.error ?? "unknown_error"}`);
  }
  return json;
}

async function slackApiGet<T extends Record<string, unknown>>(botToken: string, url: string, params: Record<string, string>): Promise<T> {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    requestUrl.searchParams.set(key, value);
  }
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Slack API request failed with HTTP ${response.status}`);
  }
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!json.ok) {
    throw new Error(`Slack API request failed: ${json.error ?? "unknown_error"}`);
  }
  return json;
}
