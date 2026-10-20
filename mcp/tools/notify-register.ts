import {
  NotificationProvider,
  globalNotifyConfigPath,
  maskGlobalNotifyConfig,
  registerNotifyChannel,
  type RegisterNotifyChannelInput,
} from "../../driver/notify-config";
import { resolveSlackUserId, sendRemoteNotification, type RemoteNotificationSender, type SlackUserResolver } from "../../driver/notify";

export type NotifyRegisterInput = {
  id?: string;
  provider: NotificationProvider;
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
  userId?: string;
  email?: string;
  handle?: string;
  dmChannelId?: string;
  openDm?: boolean;
  sendTest?: boolean;
};

export type NotifyRegisterDeps = {
  configFile?: string;
  sendRemote?: RemoteNotificationSender;
  resolveSlackUserId?: SlackUserResolver;
};

export async function looperloopNotifyRegister(input: NotifyRegisterInput, deps: NotifyRegisterDeps = {}) {
  const id = input.id ?? defaultChannelId(input);
  const registerInput = await normalizeRegisterInput({ ...input, id }, deps.resolveSlackUserId ?? resolveSlackUserId);
  const configFile = deps.configFile ?? globalNotifyConfigPath();
  const config = await registerNotifyChannel(registerInput, configFile);
  const channel = config.channels.find((candidate) => candidate.id === id);
  if (input.sendTest && channel) {
    await (deps.sendRemote ?? sendRemoteNotification)(channel, `LooperLoop notifications are connected: ${id}`);
  }
  return {
    ok: true,
    id,
    provider: input.provider,
    configPath: configFile,
    config: maskGlobalNotifyConfig(config),
  };
}

async function normalizeRegisterInput(
  input: NotifyRegisterInput & { id: string },
  slackUserResolver: SlackUserResolver,
): Promise<RegisterNotifyChannelInput> {
  if (input.provider === NotificationProvider.Telegram) {
    if (!input.botToken || !input.chatId) {
      throw new Error("Telegram registration requires botToken and chatId.");
    }
    return {
      id: input.id,
      provider: NotificationProvider.Telegram,
      enabled: input.enabled,
      botToken: input.botToken,
      chatId: input.chatId,
    };
  }
  if (input.provider === NotificationProvider.Slack) {
    if (input.webhookUrl && input.botToken) {
      throw new Error("Slack registration accepts either webhookUrl or botToken/userId, not both.");
    }
    if (input.webhookUrl) {
      return {
        id: input.id,
        provider: NotificationProvider.Slack,
        enabled: input.enabled,
        webhookUrl: input.webhookUrl,
      };
    }
    if (!input.botToken || (!input.userId && !input.dmChannelId && !input.email && !input.handle)) {
      throw new Error("Slack DM registration requires botToken and one of userId, dmChannelId, email, or handle.");
    }
    const userId = input.userId ?? (input.dmChannelId ? undefined : await slackUserResolver({
      botToken: input.botToken,
      email: input.email,
      handle: input.handle,
    }));
    return {
      id: input.id,
      provider: NotificationProvider.Slack,
      enabled: input.enabled,
      botToken: input.botToken,
      userId,
      dmChannelId: input.dmChannelId,
      openDm: input.openDm,
    };
  }
  throw new Error(`Unsupported notification provider: ${input.provider}`);
}

function defaultChannelId(input: NotifyRegisterInput): string {
  if (input.provider === NotificationProvider.Slack && !input.webhookUrl && (input.botToken || input.userId || input.dmChannelId)) {
    return "slack-dm-main";
  }
  return `${input.provider}-main`;
}
