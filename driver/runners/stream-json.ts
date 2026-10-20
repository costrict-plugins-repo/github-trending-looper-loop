import { AgentProvider, ClaudeConversationRef, CodexConversationRef, ConversationRef } from "./types";

export type ParsedStreamJson = {
  finalAssistantText: string;
  conversationRef?: ConversationRef;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function appendText(target: string[], value: unknown): void {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendText(target, item);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  if (record.type === "text" && typeof record.text === "string") {
    target.push(record.text);
    return;
  }
  if (typeof record.text === "string") {
    target.push(record.text);
  }
  if (record.content !== undefined) {
    appendText(target, record.content);
  }
}

export function parseStreamJsonLines(lines: string[], provider: AgentProvider): ParsedStreamJson {
  const assistantText: string[] = [];
  const resultText: string[] = [];
  let sessionId: string | undefined;
  let codexConversationId: string | undefined;
  let fallbackResult = "";
  let usage: ParsedStreamJson["usage"];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const event = asRecord(JSON.parse(line));
    if (!event) {
      continue;
    }
    const type = event.type;

    if (type === "system" || type === "init" || type === "session" || type === "thread.started") {
      const maybeSession = asString(event.session_id ?? event.sessionId ?? event.thread_id ?? event.threadId);
      const maybeConversation = asString(
        event.conversation_id ?? event.conversationId ?? event.thread_id ?? event.threadId ?? event.id,
      );
      if (maybeSession) {
        sessionId = maybeSession;
      }
      if (maybeConversation) {
        codexConversationId = maybeConversation;
      }
    }

    if (type === "assistant" || type === "message" || type === "response.output_text.delta" || type === "item.completed") {
      appendText(assistantText, event.message);
      appendText(assistantText, event.content);
      appendText(assistantText, event.delta);
      appendText(assistantText, event.text);
      appendText(assistantText, event.item);
    }

    if (type === "result" || type === "turn.completed") {
      appendText(resultText, event.result);
      appendText(resultText, event.text);
      const rawResult = asString(event.result);
      if (rawResult) {
        fallbackResult = rawResult;
      }
      const usageRecord = asRecord(event.usage);
      if (usageRecord) {
        usage = {
          inputTokens: asNumber(usageRecord.input_tokens),
          outputTokens: asNumber(usageRecord.output_tokens),
          costUsd: asNumber(usageRecord.cost_usd),
        };
      }
    }
  }

  const finalAssistantText = resultText.join("").trim() || assistantText.join("").trim() || fallbackResult.trim();
  const conversationRef = buildConversationRef({ provider, sessionId, codexConversationId });
  return { finalAssistantText, conversationRef, usage };
}

type BuildConversationRefParams = {
  provider: AgentProvider;
  sessionId: string | undefined;
  codexConversationId: string | undefined;
};

function buildConversationRef(params: BuildConversationRefParams): ConversationRef | undefined {
  const { provider, sessionId, codexConversationId } = params;
  if (provider === AgentProvider.ClaudeCli && sessionId) {
    return new ClaudeConversationRef(sessionId);
  }
  if (provider === AgentProvider.CodexCli) {
    const id = codexConversationId ?? sessionId;
    if (id) {
      return new CodexConversationRef(id);
    }
  }
  return undefined;
}
