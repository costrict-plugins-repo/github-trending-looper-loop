import { expect, test } from "bun:test";
import { beep, notify, terminateProcessTree } from "../../driver/platform";

type SpawnCall = { command: string; args: string[] };

function successfulSpawn(calls: SpawnCall[]) {
  return (command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    return {
      on(event: "exit" | "error", listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          queueMicrotask(() => listener(0));
        }
        return this;
      },
    };
  };
}

function failingThenSuccessfulSpawn(calls: SpawnCall[]) {
  let index = 0;
  return (command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    const code = index++ === 0 ? 1 : 0;
    return {
      on(event: "exit" | "error", listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          queueMicrotask(() => listener(code));
        }
        return this;
      },
    };
  };
}

test("windows process tree termination waits before force kill", async () => {
  const calls: SpawnCall[] = [];
  const sleeps: number[] = [];
  await terminateProcessTree({
    pid: 1234,
    graceMs: 777,
    deps: {
      platform: "win32",
      spawn: successfulSpawn(calls),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  expect(calls).toEqual([
    { command: "taskkill", args: ["/PID", "1234", "/T"] },
    { command: "taskkill", args: ["/PID", "1234", "/T", "/F"] },
  ]);
  expect(sleeps).toEqual([777]);
});

test("platform notify chooses OS notification commands with fallback", async () => {
  const windowsCalls: SpawnCall[] = [];
  await notify({ title: "title", body: "body", deps: { platform: "win32", spawn: failingThenSuccessfulSpawn(windowsCalls) } });
  expect(windowsCalls[0].command).toBe("powershell");
  expect(windowsCalls[0].args.join(" ")).toContain("BurntToast");
  expect(windowsCalls[1].command).toBe("powershell");
  expect(windowsCalls[1].args.join(" ")).toContain("ToastNotificationManager");

  const macCalls: SpawnCall[] = [];
  await notify({ title: "title", body: "body", deps: { platform: "darwin", spawn: successfulSpawn(macCalls) } });
  expect(macCalls).toEqual([{ command: "osascript", args: ["-e", 'display notification "body" with title "title"'] }]);
});

test("platform beep uses native sound command before terminal fallback", async () => {
  const linuxCalls: SpawnCall[] = [];
  let fallback = "";
  await beep({
    platform: "linux",
    spawn: failingThenSuccessfulSpawn(linuxCalls),
    stdout: { write: (chunk: string) => { fallback += chunk; return true; } },
  });
  expect(linuxCalls.map((call) => call.command)).toEqual(["paplay", "canberra-gtk-play"]);
  expect(fallback).toBe("");
});
