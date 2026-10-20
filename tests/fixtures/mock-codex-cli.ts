const scenario = process.env.MOCK_AGENT_SCENARIO ?? "ok";
const args = Bun.argv.slice(2);
const json = args.includes("--json");
const resumed = args.includes("resume");
const threadId = "mock-codex-thread";

function writeJson(text: string): void {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
}

if (scenario === "hang") {
  if (json) {
    console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
    console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial output before timeout" } }));
  } else {
    await Bun.write(Bun.stdout, "partial output before timeout\n");
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.exit(0);
}

if (scenario === "fail") {
  console.error("mock codex failure");
  process.exit(2);
}

if (scenario === "stderr") {
  console.error("codex diagnostic stderr");
}

const text = process.env.MOCK_AGENT_TEXT ?? "observer review\nOBSERVER_VERDICT: done";
if (process.env.MOCK_ECHO_ARGS === "1") {
  console.log(JSON.stringify({ args: Bun.argv.slice(2) }));
}
if (json) {
  writeJson(resumed ? "worker log text\nCOMPLETION_PROMISE_SATISFIED: CONFIRMED" : text);
} else {
  console.log(text);
}

export {};
