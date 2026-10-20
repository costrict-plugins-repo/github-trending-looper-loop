import { sendRemoteNotification, type RemoteNotificationSender } from "../../driver/notify";
import { globalNotifyConfigPath, readGlobalNotifyConfig } from "../../driver/notify-config";

export type NotifyTestInput = {
  id?: string;
  message?: string;
};

export type NotifyTestDeps = {
  configFile?: string;
  sendRemote?: RemoteNotificationSender;
};

export async function looperloopNotifyTest(input: NotifyTestInput = {}, deps: NotifyTestDeps = {}) {
  const configFile = deps.configFile ?? globalNotifyConfigPath();
  const config = await readGlobalNotifyConfig(configFile);
  const channels = input.id
    ? config.channels.filter((channel) => channel.id === input.id)
    : config.channels.filter((channel) => channel.enabled);
  if (input.id && !channels.length) {
    throw new Error(`Notification channel not found: ${input.id}`);
  }
  const sender = deps.sendRemote ?? sendRemoteNotification;
  const message = input.message ?? "LooperLoop notification test.";
  for (const channel of channels) {
    await sender(channel, message);
  }
  return {
    ok: true,
    sent: channels.map((channel) => ({ id: channel.id, provider: channel.provider })),
  };
}
