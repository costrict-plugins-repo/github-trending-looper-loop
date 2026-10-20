import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { readJson, writeJson } from "./state";

export enum NotificationProvider {
  Telegram = "telegram",
  Slack = "slack",
}

export enum NotificationEvent {
  LoopStarted = "loopStarted",
  LoopFinished = "loopFinished",
}

export type TelegramChannel = {
  id: string;
  provider: NotificationProvider.Telegram;
  enabled: boolean;
  botToken: string;
  chatId: string;
};

export type SlackWebhookChannel = {
  id: string;
  provider: NotificationProvider.Slack;
  enabled: boolean;
  webhookUrl: string;
};

export type SlackBotDmChannel = {
  id: string;
  provider: NotificationProvider.Slack;
  enabled: boolean;
  botToken: string;
  userId?: string;
  dmChannelId?: string;
  openDm: boolean;
};

export type SlackChannel = SlackWebhookChannel | SlackBotDmChannel;

export type NotificationChannel = TelegramChannel | SlackChannel;

export type GlobalNotifyConfig = {
  version: 1;
  channels: NotificationChannel[];
  events: {
    loopStarted: boolean;
    loopFinished: boolean;
  };
};

export type NotifyConfigPathDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

const CONFIG_FILE = "notify-config.json";

export function defaultGlobalNotifyConfig(): GlobalNotifyConfig {
  return {
    version: 1,
    channels: [],
    events: {
      loopStarted: true,
      loopFinished: true,
    },
  };
}

export function globalNotifyConfigDir(deps: NotifyConfigPathDeps = {}): string {
  const platform = deps.platform ?? os.platform();
  const env = deps.env ?? process.env;
  const home = deps.homedir?.() ?? os.homedir();
  if (platform === "win32") {
    return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "looperloop");
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "looperloop");
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "looperloop");
}

export function globalNotifyConfigPath(deps: NotifyConfigPathDeps = {}): string {
  const platform = deps.platform ?? os.platform();
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  return pathImpl.join(globalNotifyConfigDir(deps), CONFIG_FILE);
}

export async function readGlobalNotifyConfig(file = globalNotifyConfigPath()): Promise<GlobalNotifyConfig> {
  if (!existsSync(file)) {
    return defaultGlobalNotifyConfig();
  }
  const config = await readJson<GlobalNotifyConfig>(file);
  return {
    ...defaultGlobalNotifyConfig(),
    ...config,
    events: { ...defaultGlobalNotifyConfig().events, ...config.events },
    channels: config.channels ?? [],
  };
}

export async function writeGlobalNotifyConfig(config: GlobalNotifyConfig, file = globalNotifyConfigPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, config);
}

export type RegisterNotifyChannelInput =
  | {
      id: string;
      provider: NotificationProvider.Telegram;
      enabled?: boolean;
      botToken: string;
      chatId: string;
    }
  | {
      id: string;
      provider: NotificationProvider.Slack;
      enabled?: boolean;
      webhookUrl: string;
    }
  | {
      id: string;
      provider: NotificationProvider.Slack;
      enabled?: boolean;
      botToken: string;
      userId?: string;
      dmChannelId?: string;
      openDm?: boolean;
    };

export async function registerNotifyChannel(
  input: RegisterNotifyChannelInput,
  file = globalNotifyConfigPath(),
): Promise<GlobalNotifyConfig> {
  const config = await readGlobalNotifyConfig(file);
  const channel: NotificationChannel = input.provider === NotificationProvider.Telegram
    ? {
        id: input.id,
        provider: NotificationProvider.Telegram,
        enabled: input.enabled ?? true,
        botToken: input.botToken,
        chatId: input.chatId,
      }
    : "webhookUrl" in input
      ? {
        id: input.id,
        provider: NotificationProvider.Slack,
        enabled: input.enabled ?? true,
        webhookUrl: input.webhookUrl,
      }
      : {
        id: input.id,
        provider: NotificationProvider.Slack,
        enabled: input.enabled ?? true,
        botToken: input.botToken,
        userId: input.userId,
        dmChannelId: input.dmChannelId,
        openDm: input.openDm ?? true,
      };
  const next = {
    ...config,
    channels: [...config.channels.filter((existing) => existing.id !== input.id), channel],
  };
  await writeGlobalNotifyConfig(next, file);
  return next;
}

export async function setNotifyChannelEnabled(id: string, enabled: boolean, file = globalNotifyConfigPath()): Promise<GlobalNotifyConfig> {
  const config = await readGlobalNotifyConfig(file);
  let found = false;
  const channels = config.channels.map((channel) => {
    if (channel.id !== id) {
      return channel;
    }
    found = true;
    return { ...channel, enabled };
  });
  if (!found) {
    throw new Error(`Notification channel not found: ${id}`);
  }
  const next = { ...config, channels };
  await writeGlobalNotifyConfig(next, file);
  return next;
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export type MaskedNotificationChannel = {
  id: string;
  provider: NotificationProvider;
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
  userId?: string;
  dmChannelId?: string;
  openDm?: boolean;
};

export function maskChannel(channel: NotificationChannel): MaskedNotificationChannel {
  if (channel.provider === NotificationProvider.Telegram) {
    return {
      id: channel.id,
      provider: channel.provider,
      enabled: channel.enabled,
      botToken: maskSecret(channel.botToken),
      chatId: channel.chatId,
    };
  }
  if ("webhookUrl" in channel) {
    return {
      id: channel.id,
      provider: channel.provider,
      enabled: channel.enabled,
      webhookUrl: maskSecret(channel.webhookUrl),
    };
  }
  return {
    id: channel.id,
    provider: channel.provider,
    enabled: channel.enabled,
    botToken: maskSecret(channel.botToken),
    userId: channel.userId,
    dmChannelId: channel.dmChannelId,
    openDm: channel.openDm,
  };
}

export function maskGlobalNotifyConfig(config: GlobalNotifyConfig): Omit<GlobalNotifyConfig, "channels"> & { channels: MaskedNotificationChannel[] } {
  return {
    ...config,
    channels: config.channels.map(maskChannel),
  };
}
