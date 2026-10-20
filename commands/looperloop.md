---
description: "Start a detached looperloop run"
argument-hint: "TASK -c \"max N, opus agent, opus reviewer\""
allowed-tools: ["mcp__looperloop__looperloop_start"]
---

# /looperloop

Parse the user request into a `looperloop_start` tool call.

Rules:

1. Everything before `-c` is the task.
2. Parse `-c "..."` as natural-language config.
3. Push back before calling the tool when:
   - the stop condition is not verifiable,
   - `maxIter` is missing,
   - worker or observer model roles contradict each other,
   - the workspace directory is not known.
4. Use model refs with explicit providers:
   - Claude worker example: `{ "provider": "claude-cli", "model": "opus", "effort": "high" }`
   - Claude reviewer example: `{ "provider": "claude-cli", "model": "sonnet", "effort": "high" }`
   - Codex worker or reviewer example: `{ "provider": "codex-cli", "model": "gpt-5.5", "effort": "high" }`
   - The MCP schema accepts `effort` inside both `worker` and every `observers[]` model ref. Do not omit it when the user asks for a specific effort.
   - Treat "agent" and "worker" as synonyms.
   - Treat "reviewer", "judge", and "observer" as synonyms.
   - Supported Claude aliases for either role: `opus`, `sonnet`.
   - Supported GPT/Codex aliases for either role: `gpt-5.5`.
   - Supported effort values: `low`, `medium`, `high`, `xhigh`.
   - Default effort is `high`. Use `low effort` when explicitly requested for cheap/smoke/test runs.
   - If the config says "low effort for all" or similar, set `"effort": "low"` on the worker and on every observer.
   - Never tell the user effort is ignored by the MCP schema; this plugin schema supports it.
5. Call `looperloop_start` only after the schema is clear.
6. After start, tell the user the loop id and that status/completion will be surfaced automatically.

Default config:

```json
{
  "worker": { "provider": "claude-cli", "model": "opus", "effort": "high" },
  "observers": [{ "provider": "claude-cli", "model": "opus", "effort": "high" }],
  "notify": ["sound", "toast"]
}
```

Examples:

```text
-c "max 3, opus agent, opus reviewer"
-c "max 3, sonnet agent, opus reviewer"
-c "max 3, gpt-5.5 agent, opus reviewer"
-c "max 3, gpt-5.5 agent, gpt-5.5 reviewer"
-c "max 1, gpt-5.5 agent low effort, sonnet reviewer low effort"
```
