const args = Bun.argv.slice(2);
const scenario = process.env.MOCK_AGENT_SCENARIO ?? "ok";
const userPrompt = args.find((arg) => !arg.startsWith("-") && arg !== "stream-json" && arg !== "1") ?? "";
const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] ?? "mock-session-resumed" : "mock-session";

function write(event: unknown): void {
  console.log(JSON.stringify(event));
}

if (scenario === "hang") {
  write({ type: "system", session_id: sessionId });
  write({ type: "assistant", message: { content: [{ type: "text", text: "partial output before timeout" }] } });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.exit(0);
}

if (scenario === "malformed") {
  console.log("{bad json");
  process.exit(0);
}

if (scenario === "fail") {
  console.error("mock failure");
  process.exit(3);
}

if (scenario === "stderr") {
  console.error("diagnostic stderr");
}

const text =
  process.env.MOCK_AGENT_TEXT ??
  (userPrompt.includes("logging turn") || resumeIndex >= 0
    ? "worker log text\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED"
    : "work complete");

write({ type: "system", session_id: sessionId, mcp_servers: { connected: ["mock"], failed: [] } });
if (process.env.MOCK_ECHO_ARGS === "1") {
  write({ type: "args", args });
}
write({ type: "assistant", message: { content: [{ type: "text", text }] } });
write({ type: "result", usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } });

export {};
