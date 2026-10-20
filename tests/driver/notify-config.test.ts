import { expect, test } from "bun:test";
import path from "node:path";
import {
  NotificationProvider,
  globalNotifyConfigPath,
  maskChannel,
  readGlobalNotifyConfig,
  registerNotifyChannel,
  setNotifyChannelEnabled,
} from "../../driver/notify-config";
import { tempWorkspace } from "./helpers";

test("global notify config path follows OS user config locations", () => {
  expect(globalNotifyConfigPath({ platform: "win32", env: { APPDATA: "C:\\Users\\mike\\AppData\\Roaming" }, homedir: () => "C:\\Users\\mike" }))
    .toBe("C:\\Users\\mike\\AppData\\Roaming\\looperloop\\notify-config.json");
  expect(globalNotifyConfigPath({ platform: "darwin", env: {}, homedir: () => "/Users/mike" }))
    .toBe("/Users/mike/Library/Application Support/looperloop/notify-config.json");
  expect(globalNotifyConfigPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/home/mike/.config" }, homedir: () => "/home/mike" }))
    .toBe("/home/mike/.config/looperloop/notify-config.json");
});

test("global notify config defaults and registration keep secrets maskable", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");

  expect(await readGlobalNotifyConfig(configFile)).toEqual({
    version: 1,
    channels: [],
    events: { loopStarted: true, loopFinished: true },
  });

  const config = await registerNotifyChannel(
    {
      id: "telegram-main",
      provider: NotificationProvider.Telegram,
      enabled: true,
      botToken: "1234567890:abcdef",
      chatId: "42",
    },
    configFile,
  );

  expect(config.channels).toHaveLength(1);
  expect(maskChannel(config.channels[0])).toEqual({
    id: "telegram-main",
    provider: NotificationProvider.Telegram,
    enabled: true,
    botToken: "1234...cdef",
    chatId: "42",
  });
});

test("global notify config stores and masks Slack bot DM channels", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");

  const config = await registerNotifyChannel(
    {
      id: "slack-dm-main",
      provider: NotificationProvider.Slack,
      enabled: true,
      botToken: "xoxb-super-secret",
      userId: "U123",
      openDm: true,
    },
    configFile,
  );

  expect(config.channels[0]).toMatchObject({
    id: "slack-dm-main",
    provider: NotificationProvider.Slack,
    botToken: "xoxb-super-secret",
    userId: "U123",
    openDm: true,
  });
  expect(maskChannel(config.channels[0])).toEqual({
    id: "slack-dm-main",
    provider: NotificationProvider.Slack,
    enabled: true,
    botToken: "xoxb...cret",
    userId: "U123",
    dmChannelId: undefined,
    openDm: true,
  });
});

test("global notify config toggles channel enabled without changing secrets", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  await registerNotifyChannel(
    {
      id: "slack-dm-main",
      provider: NotificationProvider.Slack,
      enabled: true,
      botToken: "xoxb-super-secret",
      userId: "U123",
    },
    configFile,
  );

  const disabled = await setNotifyChannelEnabled("slack-dm-main", false, configFile);
  expect(disabled.channels[0]).toMatchObject({
    id: "slack-dm-main",
    enabled: false,
    botToken: "xoxb-super-secret",
  });

  const enabled = await setNotifyChannelEnabled("slack-dm-main", true, configFile);
  expect(enabled.channels[0]).toMatchObject({
    id: "slack-dm-main",
    enabled: true,
    botToken: "xoxb-super-secret",
  });
});

test("global notify config rejects toggling unknown channel", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  await expect(setNotifyChannelEnabled("missing", false, configFile)).rejects.toThrow("Notification channel not found");
});
