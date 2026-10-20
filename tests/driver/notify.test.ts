import { expect, test } from "bun:test";
import { notifyCompletion, notifyLoopStarted, resolveSlackUserId, sendRemoteNotification, type LoopResult } from "../../driver/notify";
import { NotificationProvider, type GlobalNotifyConfig, type NotificationChannel } from "../../driver/notify-config";
import { AgentProvider } from "../../driver/runners/types";
import { ActivityStage, ActivityStatus, LoopStatus, NotifyKind } from "../../driver/state";

function resultWithNotify(notify: NotifyKind[]): LoopResult {
  return {
    loopId: "loop-notify",
    outcome: "done",
    completedAt: new Date().toISOString(),
    state: {
      loopId: "loop-notify",
      workspaceDir: "F:\\workspace",
      iter: 1,
      maxIter: 2,
      status: LoopStatus.Done,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      warnings: [],
    },
    config: {
      loopId: "loop-notify",
      workspaceDir: "F:\\workspace",
      task: "finish",
      maxIter: 2,
      worker: { provider: AgentProvider.ClaudeCli, model: "opus" },
      observers: [{ provider: AgentProvider.CodexCli, model: "gpt-5.5" }],
      stopCondition: "finish",
      notify,
    },
  };
}

test("notifyCompletion respects configured notification kinds", async () => {
  const calls: string[] = [];
  const originalLog = console.log;
  console.log = () => {};
  const notifier = {
    beep: async () => {
      calls.push("sound");
    },
    notify: async ({ title, body = "" }: { title: string; body?: string }) => {
      calls.push(`toast:${title}:${body}`);
    },
  };

  try {
    await notifyCompletion(resultWithNotify([]), notifier);
    expect(calls).toEqual([]);

    await notifyCompletion(resultWithNotify([NotifyKind.Sound]), notifier);
    expect(calls).toEqual(["sound"]);

    calls.length = 0;
    await notifyCompletion(resultWithNotify([NotifyKind.Toast]), notifier);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("toast:looperloop complete");

    calls.length = 0;
    await notifyCompletion(resultWithNotify([NotifyKind.Sound, NotifyKind.Toast]), notifier);
    expect(calls[0]).toBe("sound");
    expect(calls[1]).toContain("toast:looperloop complete");
  } finally {
    console.log = originalLog;
  }
});

test("notifyLoopStarted sends globally configured remote notifications", async () => {
  const calls: Array<{ channel: NotificationChannel; message: string }> = [];
  const config: GlobalNotifyConfig = {
    version: 1,
    channels: [
      { id: "telegram-main", provider: NotificationProvider.Telegram, enabled: true, botToken: "token", chatId: "chat" },
      { id: "slack-muted", provider: NotificationProvider.Slack, enabled: false, webhookUrl: "https://hooks.slack.test/off" },
    ],
    events: { loopStarted: true, loopFinished: true },
  };
  const result = resultWithNotify([NotifyKind.Global]);

  await notifyLoopStarted(
    { loopId: result.loopId, state: { ...result.state, statusUrl: "http://localhost:47000/runs/loop-notify/" }, config: result.config },
    {
      beep: async () => undefined,
      notify: async () => undefined,
      readGlobalConfig: async () => config,
      sendRemote: async (channel, message) => {
        calls.push({ channel, message });
      },
    },
  );

  expect(calls).toHaveLength(1);
  expect(calls[0].channel.id).toBe("telegram-main");
  expect(calls[0].message).toContain("LooperLoop started: loop-notify");
  expect(calls[0].message).toContain("Status: http://localhost:47000/runs/loop-notify/");
});

test("notifyCompletion sends globally configured finish messages", async () => {
  const calls: string[] = [];
  const config: GlobalNotifyConfig = {
    version: 1,
    channels: [{ id: "slack-main", provider: NotificationProvider.Slack, enabled: true, webhookUrl: "https://hooks.slack.test/on" }],
    events: { loopStarted: true, loopFinished: true },
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = resultWithNotify([NotifyKind.Global]);
    result.state.activity = [
      {
        iter: 1,
        stage: ActivityStage.WorkerLog,
        status: ActivityStatus.Done,
        title: "Worker finished",
        summary: "Updated the notification flow and documented how to register channels.",
        updatedAt: new Date().toISOString(),
      },
    ];
    await notifyCompletion(result, {
      beep: async () => undefined,
      notify: async () => undefined,
      readGlobalConfig: async () => config,
      sendRemote: async (_channel, message) => {
        calls.push(message);
      },
    });
  } finally {
    console.log = originalLog;
  }

  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("LooperLoop finished: loop-notify");
  expect(calls[0]).toContain("TLDR: Updated the notification flow and documented how to register channels.");
  expect(calls[0]).toContain("Outcome: done");
  expect(calls[0]).toContain("RESULT.json");
});

test("remote notification sender posts Telegram and Slack payloads", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    await sendRemoteNotification(
      { id: "telegram-main", provider: NotificationProvider.Telegram, enabled: true, botToken: "123456:secret", chatId: "42" },
      "hello telegram",
    );
    await sendRemoteNotification(
      { id: "slack-main", provider: NotificationProvider.Slack, enabled: true, webhookUrl: "https://hooks.slack.test/abc" },
      "hello slack",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls[0]).toEqual({
    url: "https://api.telegram.org/bot123456:secret/sendMessage",
    body: { chat_id: "42", text: "hello telegram", disable_web_page_preview: true },
  });
  expect(calls[1]).toEqual({
    url: "https://hooks.slack.test/abc",
    body: { text: "hello slack" },
  });
});

test("remote notification sender opens Slack DM before posting when user id is provided", async () => {
  const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string>).authorization,
    });
    if (String(url).endsWith("/conversations.open")) {
      return Response.json({ ok: true, channel: { id: "D123" } });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await sendRemoteNotification(
      { id: "slack-dm-main", provider: NotificationProvider.Slack, enabled: true, botToken: "xoxb-secret", userId: "U123", openDm: true },
      "hello dm",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    {
      url: "https://slack.com/api/conversations.open",
      body: { users: "U123" },
      authorization: "Bearer xoxb-secret",
    },
    {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "D123", text: "hello dm" },
      authorization: "Bearer xoxb-secret",
    },
  ]);
});

test("remote notification sender can post Slack bot messages directly to provided target", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await sendRemoteNotification(
      { id: "slack-dm-main", provider: NotificationProvider.Slack, enabled: true, botToken: "xoxb-secret", userId: "U123", openDm: false },
      "hello direct user",
    );
    await sendRemoteNotification(
      { id: "slack-dm-known", provider: NotificationProvider.Slack, enabled: true, botToken: "xoxb-secret", dmChannelId: "D456", openDm: true },
      "hello direct dm",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "U123", text: "hello direct user" },
    },
    {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "D456", text: "hello direct dm" },
    },
  ]);
});

test("slack user resolver finds user by email", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string>).authorization,
    });
    return Response.json({ ok: true, user: { id: "U123" } });
  }) as typeof fetch;

  try {
    await expect(resolveSlackUserId({ botToken: "xoxb-secret", email: "mike@example.com" })).resolves.toBe("U123");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    {
      url: "https://slack.com/api/users.lookupByEmail?email=mike%40example.com",
      authorization: "Bearer xoxb-secret",
    },
  ]);
});

test("slack user resolver finds user by handle across username and profile fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    ok: true,
    members: [
      { id: "U001", name: "someone", profile: { display_name: "Someone", real_name: "Some One" } },
      { id: "U123", name: "mike", profile: { display_name: "Mike", real_name: "Mikhail" } },
      { id: "B001", name: "buildbot", is_bot: true, profile: { display_name: "mike" } },
    ],
  })) as unknown as typeof fetch;

  try {
    await expect(resolveSlackUserId({ botToken: "xoxb-secret", handle: "@mike" })).resolves.toBe("U123");
    await expect(resolveSlackUserId({ botToken: "xoxb-secret", handle: "Mikhail" })).resolves.toBe("U123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("slack user resolver rejects ambiguous handle matches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    ok: true,
    members: [
      { id: "U001", name: "mike", profile: { display_name: "Mike" } },
      { id: "U002", name: "other", profile: { display_name: "mike" } },
    ],
  })) as unknown as typeof fetch;

  try {
    await expect(resolveSlackUserId({ botToken: "xoxb-secret", handle: "mike" })).rejects.toThrow("matched multiple users");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
