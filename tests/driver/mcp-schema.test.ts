import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotificationProvider } from "../../driver/notify-config";
import { parseModelRef } from "../../driver/main";
import { AgentProvider, ReasoningEffort } from "../../driver/runners/types";
import { LoopStatus } from "../../driver/state";
import { handle } from "../../mcp/server";
import { looperloopNotifyRegister } from "../../mcp/tools/notify-register";
import { looperloopNotifySetEnabled } from "../../mcp/tools/notify-set-enabled";
import { looperloopNotifyStatus } from "../../mcp/tools/notify-status";
import { looperloopNotifyTest } from "../../mcp/tools/notify-test";
import { looperloopOpenStatus } from "../../mcp/tools/open-status";
import { looperloopStatus } from "../../mcp/tools/status";
import { tempWorkspace } from "./helpers";

test("mcp tools expose concrete input schemas and result guidance", async () => {
  const result = (await handle({ method: "tools/list" })) as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
  const start = result.tools.find((tool) => tool.name === "looperloop_start");
  const status = result.tools.find((tool) => tool.name === "looperloop_status");
  const resultTool = result.tools.find((tool) => tool.name === "looperloop_result");
  const openStatus = result.tools.find((tool) => tool.name === "looperloop_open_status");
  const notifyRegister = result.tools.find((tool) => tool.name === "looperloop_notify_register");
  const notifySetEnabled = result.tools.find((tool) => tool.name === "looperloop_notify_set_enabled");
  const notifyStatus = result.tools.find((tool) => tool.name === "looperloop_notify_status");
  const notifyTest = result.tools.find((tool) => tool.name === "looperloop_notify_test");
  expect(start?.inputSchema).toBeDefined();
  expect(start?.inputSchema.additionalProperties).toBe(false);
  expect(JSON.stringify(start?.inputSchema)).toContain("claude-cli");
  expect(JSON.stringify(start?.inputSchema)).toContain("codex-cli");
  expect(JSON.stringify(start?.inputSchema)).toContain("effort");
  expect(JSON.stringify(start?.inputSchema)).toContain("xhigh");
  expect(JSON.stringify(start?.inputSchema)).toContain("Optional reasoning effort");
  expect(start?.description).toContain("call looperloop_result");
  expect(start?.description).toContain("optional effort");
  expect(status?.description).toContain("terminal");
  expect(status?.description).toContain("looperloop_result");
  expect(resultTool?.description).toContain("user-facing result");
  expect(resultTool?.description).toContain("branchGraph");
  expect(resultTool?.inputSchema.additionalProperties).toBe(false);
  expect(openStatus?.description).toContain("Reopen");
  expect(openStatus?.description).toContain("running loop_id");
  expect(openStatus?.inputSchema.additionalProperties).toBe(false);
  expect(JSON.stringify(start?.inputSchema)).toContain("global");
  expect(notifyRegister?.description).toContain("global Telegram or Slack");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("webhookUrl");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("botToken");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("userId");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("email");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("handle");
  expect(JSON.stringify(notifyRegister?.inputSchema)).toContain("openDm");
  expect(notifyStatus?.description).toContain("masked");
  expect(notifySetEnabled?.description).toContain("Enable or disable");
  expect(notifySetEnabled?.inputSchema.additionalProperties).toBe(false);
  expect(JSON.stringify(notifySetEnabled?.inputSchema)).toContain("enabled");
  expect(notifyTest?.description).toContain("test message");
});

test("model refs parse optional reasoning effort and default high", () => {
  expect(parseModelRef("claude-cli:opus")).toEqual({
    provider: AgentProvider.ClaudeCli,
    model: "opus",
    effort: ReasoningEffort.High,
  });
  expect(parseModelRef("codex-cli:gpt-5.5:low")).toEqual({
    provider: AgentProvider.CodexCli,
    model: "gpt-5.5",
    effort: ReasoningEffort.Low,
  });
});

test("status tool returns planned shape with elapsed", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-status");
  await mkdir(loopDir, { recursive: true });
  await writeFile(
    path.join(loopDir, "state.json"),
    JSON.stringify({
      loopId: "loop-status",
      workspaceDir,
      iter: 1,
      maxIter: 3,
      status: "worker-running",
      lastVerdict: "CONTINUE",
      currentActor: "worker.turn1",
      statusUrl: "http://localhost:47000",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
    }),
    "utf8",
  );
  const status = await looperloopStatus({ workspaceDir, loop_id: "loop-status" });
  expect(status.iter).toBe(1);
  expect(status.maxIter).toBe(3);
  expect(status.elapsed).toBeGreaterThanOrEqual(0);
  expect(status.statusUrl).toBe("http://localhost:47000");
  expect(status.activity).toEqual([]);
});

test("open status tool reopens browser window for running loop", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-open");
  await mkdir(loopDir, { recursive: true });
  await writeFile(
    path.join(loopDir, "state.json"),
    JSON.stringify({
      loopId: "loop-open",
      workspaceDir,
      iter: 1,
      maxIter: 3,
      status: LoopStatus.WorkerRunning,
      statusUrl: "http://localhost:47000/runs/loop-open/",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
    }),
    "utf8",
  );

  const opened: { url?: string; width?: number; height?: number } = {};
  const result = await looperloopOpenStatus(
    { workspaceDir, loop_id: "loop-open" },
    {
      openWindow: async (url, options) => {
        opened.url = url;
        opened.width = options.width;
        opened.height = options.height;
      },
    },
  );

  expect(result).toEqual({
    ok: true,
    loop_id: "loop-open",
    status: LoopStatus.WorkerRunning,
    statusUrl: "http://localhost:47000/runs/loop-open/",
  });
  expect(opened).toEqual({ url: "http://localhost:47000/runs/loop-open/", width: 420, height: 640 });
});

test("open status tool rejects terminal loops", async () => {
  const workspaceDir = await tempWorkspace();
  const loopDir = path.join(workspaceDir, "looper", "loop-runs", "loop-done");
  await mkdir(loopDir, { recursive: true });
  await writeFile(
    path.join(loopDir, "state.json"),
    JSON.stringify({
      loopId: "loop-done",
      workspaceDir,
      iter: 2,
      maxIter: 2,
      status: LoopStatus.Done,
      statusUrl: "http://localhost:47000/runs/loop-done/",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
    }),
    "utf8",
  );

  await expect(looperloopOpenStatus({ workspaceDir, loop_id: "loop-done" })).rejects.toThrow("is not running");
});

test("notification registration stores global config with masked output", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  const sent: string[] = [];

  const registered = await looperloopNotifyRegister(
    {
      id: "slack-main",
      provider: NotificationProvider.Slack,
      webhookUrl: "https://hooks.slack.test/secret-token",
      sendTest: true,
    },
    {
      configFile,
      sendRemote: async (_channel, message) => {
        sent.push(message);
      },
    },
  );

  expect(registered.config.channels[0]).toEqual({
    id: "slack-main",
    provider: NotificationProvider.Slack,
    enabled: true,
    webhookUrl: "http...oken",
  });
  expect(sent).toEqual(["LooperLoop notifications are connected: slack-main"]);
  expect(await readFile(configFile, "utf8")).toContain("https://hooks.slack.test/secret-token");

  const status = await looperloopNotifyStatus({}, { configFile });
  expect(status.config.channels[0]).toEqual(registered.config.channels[0]);
});

test("notification test sends to enabled channels or a named channel", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  await looperloopNotifyRegister({ id: "telegram-main", provider: NotificationProvider.Telegram, botToken: "token", chatId: "42" }, { configFile });
  await looperloopNotifyRegister({ id: "slack-off", provider: NotificationProvider.Slack, webhookUrl: "https://hooks.slack.test/off", enabled: false }, { configFile });
  const sent: string[] = [];

  await looperloopNotifyTest(
    { message: "hello" },
    {
      configFile,
      sendRemote: async (channel, message) => {
        sent.push(`${channel.id}:${message}`);
      },
    },
  );
  await looperloopNotifyTest(
    { id: "slack-off", message: "named" },
    {
      configFile,
      sendRemote: async (channel, message) => {
        sent.push(`${channel.id}:${message}`);
      },
    },
  );

  expect(sent).toEqual(["telegram-main:hello", "slack-off:named"]);
});

test("notification registration supports Slack bot DM channels", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  const sent: Array<{ id: string; message: string }> = [];

  const registered = await looperloopNotifyRegister(
    {
      provider: NotificationProvider.Slack,
      botToken: "xoxb-super-secret",
      userId: "U123456",
      sendTest: true,
    },
    {
      configFile,
      sendRemote: async (channel, message) => {
        sent.push({ id: channel.id, message });
      },
    },
  );

  expect(registered.id).toBe("slack-dm-main");
  expect(registered.config.channels[0]).toEqual({
    id: "slack-dm-main",
    provider: NotificationProvider.Slack,
    enabled: true,
    botToken: "xoxb...cret",
    userId: "U123456",
    dmChannelId: undefined,
    openDm: true,
  });
  expect(sent).toEqual([{ id: "slack-dm-main", message: "LooperLoop notifications are connected: slack-dm-main" }]);
  expect(await readFile(configFile, "utf8")).toContain("xoxb-super-secret");
});

test("notification registration resolves Slack DM user by email or handle", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  const lookups: Array<{ email?: string; handle?: string }> = [];

  const byEmail = await looperloopNotifyRegister(
    {
      id: "slack-email",
      provider: NotificationProvider.Slack,
      botToken: "xoxb-super-secret",
      email: "mike@example.com",
    },
    {
      configFile,
      resolveSlackUserId: async ({ email, handle }) => {
        lookups.push({ email, handle });
        return "UEMAIL";
      },
    },
  );
  const byHandle = await looperloopNotifyRegister(
    {
      id: "slack-handle",
      provider: NotificationProvider.Slack,
      botToken: "xoxb-super-secret",
      handle: "@mike",
    },
    {
      configFile,
      resolveSlackUserId: async ({ email, handle }) => {
        lookups.push({ email, handle });
        return "UHANDLE";
      },
    },
  );

  expect(lookups).toEqual([{ email: "mike@example.com", handle: undefined }, { email: undefined, handle: "@mike" }]);
  expect(byEmail.config.channels[0]).toMatchObject({ id: "slack-email", userId: "UEMAIL" });
  expect(byHandle.config.channels[1]).toMatchObject({ id: "slack-handle", userId: "UHANDLE" });
});

test("notification set enabled toggles channel without requiring secret", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  await looperloopNotifyRegister({ id: "telegram-main", provider: NotificationProvider.Telegram, botToken: "telegram-secret", chatId: "42" }, { configFile });

  const disabled = await looperloopNotifySetEnabled({ id: "telegram-main", enabled: false }, { configFile });
  expect(disabled).toMatchObject({
    ok: true,
    id: "telegram-main",
    enabled: false,
  });
  expect(disabled.config.channels[0]).toEqual({
    id: "telegram-main",
    provider: NotificationProvider.Telegram,
    enabled: false,
    botToken: "tele...cret",
    chatId: "42",
  });
  expect(await readFile(configFile, "utf8")).toContain("telegram-secret");

  const enabled = await looperloopNotifySetEnabled({ id: "telegram-main", enabled: true }, { configFile });
  expect(enabled.config.channels[0]).toMatchObject({ id: "telegram-main", enabled: true });
});

test("notification set enabled rejects unknown channel", async () => {
  const workspaceDir = await tempWorkspace();
  const configFile = path.join(workspaceDir, "notify-config.json");
  await expect(looperloopNotifySetEnabled({ id: "missing", enabled: false }, { configFile })).rejects.toThrow("Notification channel not found");
});
