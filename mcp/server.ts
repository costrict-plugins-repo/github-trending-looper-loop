import { looperloopCancel } from "./tools/cancel";
import { looperloopList } from "./tools/list";
import { looperloopLogs } from "./tools/logs";
import { looperloopNotifyRegister } from "./tools/notify-register";
import { looperloopNotifySetEnabled } from "./tools/notify-set-enabled";
import { looperloopNotifyStatus } from "./tools/notify-status";
import { looperloopNotifyTest } from "./tools/notify-test";
import { looperloopOpenStatus } from "./tools/open-status";
import { looperloopResult } from "./tools/result";
import { looperloopStart } from "./tools/start";
import { looperloopStatus } from "./tools/status";
import { looperloopTail } from "./tools/tail";
import readline from "node:readline";

type JsonRpcRequest = {
  id?: string | number;
  method: string;
  params?: unknown;
};

const tools = {
  looperloop_start: looperloopStart,
  looperloop_status: looperloopStatus,
  looperloop_cancel: looperloopCancel,
  looperloop_list: looperloopList,
  looperloop_logs: looperloopLogs,
  looperloop_tail: looperloopTail,
  looperloop_result: looperloopResult,
  looperloop_open_status: looperloopOpenStatus,
  looperloop_notify_register: looperloopNotifyRegister,
  looperloop_notify_set_enabled: looperloopNotifySetEnabled,
  looperloop_notify_status: looperloopNotifyStatus,
  looperloop_notify_test: looperloopNotifyTest,
};

const agentProviderSchema = { type: "string", enum: ["claude-cli", "codex-cli"] };
const reasoningEffortSchema = { type: "string", enum: ["low", "medium", "high", "xhigh"] };
const notificationProviderSchema = { type: "string", enum: ["telegram", "slack"] };
const modelRefSchema = {
  type: "object",
  required: ["provider", "model"],
  additionalProperties: false,
  properties: {
    provider: agentProviderSchema,
    model: { type: "string", minLength: 1 },
    effort: {
      ...reasoningEffortSchema,
      description: "Optional reasoning effort for this agent model. Defaults to high. Use low, medium, high, or xhigh.",
    },
  },
};
const schemas: Record<keyof typeof tools, unknown> = {
  looperloop_start: {
    type: "object",
    required: ["workspaceDir", "task", "maxIter"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string", minLength: 1 },
      task: { type: "string", minLength: 1 },
      maxIter: { type: "number", minimum: 1 },
      worker: modelRefSchema,
      observers: { type: "array", items: modelRefSchema },
      stopCondition: { type: "string" },
      notify: {
        type: "array",
        items: { type: "string", enum: ["sound", "toast", "global"] },
        description: "Optional notification targets. Omit to use sound, toast, and globally registered Telegram/Slack channels. Use [] to disable.",
      },
    },
  },
  looperloop_status: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
    },
  },
  looperloop_cancel: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
    },
  },
  looperloop_list: {
    type: "object",
    required: ["workspaceDir"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string", minLength: 1 },
    },
  },
  looperloop_logs: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
      iter: { type: "number", minimum: 1 },
    },
  },
  looperloop_tail: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
      lines: { type: "number", minimum: 1 },
      raw: { type: "boolean" },
    },
  },
  looperloop_result: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
    },
  },
  looperloop_open_status: {
    type: "object",
    required: ["loop_id"],
    additionalProperties: false,
    properties: {
      workspaceDir: { type: "string" },
      loop_id: { type: "string", minLength: 1 },
    },
  },
  looperloop_notify_register: {
    type: "object",
    required: ["provider"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, description: "Optional channel id. Defaults to telegram-main or slack-main." },
      provider: notificationProviderSchema,
      enabled: { type: "boolean" },
      botToken: { type: "string", minLength: 1, description: "Telegram bot token or Slack Bot User OAuth Token (xoxb-...). Stored globally and never returned unmasked." },
      chatId: { type: "string", minLength: 1, description: "Telegram chat id." },
      webhookUrl: { type: "string", minLength: 1, description: "Slack incoming webhook URL. Stored globally and never returned unmasked." },
      userId: { type: "string", minLength: 1, description: "Slack user id for bot DM delivery, for example U123456." },
      email: { type: "string", minLength: 1, description: "Slack user email. Resolves to userId via users.lookupByEmail before saving." },
      handle: { type: "string", minLength: 1, description: "Slack @handle, username, display name, or real name. Resolves through users.list before saving." },
      dmChannelId: { type: "string", minLength: 1, description: "Optional Slack DM channel id. If omitted, LooperLoop opens the DM from userId." },
      openDm: { type: "boolean", description: "For Slack bot DMs, open/resume the DM with conversations.open before posting. Defaults to true." },
      sendTest: { type: "boolean", description: "Send a short test message after saving the channel." },
    },
  },
  looperloop_notify_status: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  looperloop_notify_set_enabled: {
    type: "object",
    required: ["id", "enabled"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, description: "Registered notification channel id, such as slack-dm-main or telegram-main." },
      enabled: { type: "boolean", description: "Set false to disable this channel without deleting or re-entering its secret." },
    },
  },
  looperloop_notify_test: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, description: "Optional channel id. Omit to test all enabled global channels." },
      message: { type: "string", minLength: 1 },
    },
  },
};

const descriptions: Record<keyof typeof tools, string> = {
  looperloop_start:
    "Start a LooperLoop run. Worker and observers accept optional effort values inside each model ref: low, medium, high, or xhigh. Omit notify to use sound, toast, and globally registered Telegram/Slack channels. After starting, poll looperloop_status. When status is terminal, call looperloop_result and present its userFacingResult to the user.",
  looperloop_status:
    "Read current loop status, including activity entries for recently completed worker, observer, and decision steps. Poll this until status is terminal, then call looperloop_result and present its userFacingResult to the user.",
  looperloop_cancel: "Request cancellation for a running loop and write a cancelled result fallback if needed.",
  looperloop_list: "List loop runs in a workspace by reading their state.json files.",
  looperloop_logs:
    "Return markdown and raw files for a loop or iteration. Use this for detailed inspection after looperloop_result identifies which files matter.",
  looperloop_tail: "Return the latest worker log tail by default, or raw output tail when raw is true.",
  looperloop_result:
    "Return the final result package for a loop_id: user-facing result text, exact entrypoint file, branchGraph for parallel side-work, all iteration files, and instructions for presenting the result.",
  looperloop_open_status: "Reopen the browser status window for a running loop_id. Terminal runs are rejected; use looperloop_result for completed runs.",
  looperloop_notify_register:
    "Register a global Telegram or Slack notification channel for this OS user. Slack accepts either webhookUrl or botToken plus userId/dmChannelId/email/handle for bot DMs. Secrets are stored in the user config dir and returned only masked.",
  looperloop_notify_status: "Show globally registered notification channels with secrets masked.",
  looperloop_notify_set_enabled: "Enable or disable a globally registered notification channel by id without requiring its secret again.",
  looperloop_notify_test: "Send a test message to one registered notification channel, or all enabled channels when id is omitted.",
};

export async function handle(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "looperloop", version: "0.1.0" },
    };
  }
  if (request.method === "tools/list") {
    return {
      tools: Object.keys(tools).map((name) => ({
        name,
        description: descriptions[name as keyof typeof tools],
        inputSchema: schemas[name as keyof typeof tools],
      })),
    };
  }
  if (request.method === "tools/call") {
    const params = request.params as { name: keyof typeof tools; arguments?: unknown };
    const fn = tools[params.name];
    if (!fn) {
      throw new Error(`Unknown tool ${params.name}`);
    }
    const result = await fn(params.arguments as never);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  return {};
}

if (import.meta.main) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const cleanLine = line.replace(/^\uFEFF/, "");
    if (!cleanLine.trim()) {
      continue;
    }
    const request = JSON.parse(cleanLine) as JsonRpcRequest;
    try {
      const result = await handle(request);
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  }
}
