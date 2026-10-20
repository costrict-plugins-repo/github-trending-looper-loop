import { spawn } from "node:child_process";
import os from "node:os";

type SpawnedProcess = {
  on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => SpawnedProcess;
  unref?: () => void;
};

type SpawnFn = (command: string, args?: readonly string[], options?: Record<string, unknown>) => SpawnedProcess;

type PlatformDeps = {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  sleep?: (ms: number) => Promise<void>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

export type WindowOptions = {
  width: number;
  height: number;
};

function currentPlatform(deps: PlatformDeps = {}): NodeJS.Platform {
  return deps.platform ?? os.platform();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SpawnWaitParams = {
  command: string;
  args: string[];
  deps?: PlatformDeps;
};

function spawnWait({ command, args, deps = {} }: SpawnWaitParams): Promise<boolean> {
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);
  return new Promise((resolve) => {
    const child = spawnFn(command, args, { windowsHide: true, stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function openStatusWindow(url: string, options: WindowOptions): Promise<void> {
  const platform = os.platform();
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", `msedge`, `--app=${url}`, `--window-size=${options.width},${options.height}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export type SpawnDetachedParams = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
};

export function spawnDetached(params: SpawnDetachedParams): number | undefined {
  const { command, args, cwd, env = {} } = params;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function killOrFalse(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  return killOrFalse(-pid, signal) || killOrFalse(pid, signal);
}

export type TerminateProcessTreeParams = {
  pid: number;
  graceMs?: number;
  deps?: PlatformDeps;
};

export async function terminateProcessTree({ pid, graceMs = 10000, deps = {} }: TerminateProcessTreeParams): Promise<void> {
  if (currentPlatform(deps) === "win32") {
    await spawnWait({ command: "taskkill", args: ["/PID", String(pid), "/T"], deps });
    await (deps.sleep ?? sleep)(graceMs);
    await spawnWait({ command: "taskkill", args: ["/PID", String(pid), "/T", "/F"], deps });
    return;
  }
  if (!signalProcessTree(pid, "SIGTERM")) {
    return;
  }
  await (deps.sleep ?? sleep)(graceMs);
  signalProcessTree(pid, "SIGKILL");
}

export type NotifyParams = {
  title: string;
  body?: string;
  deps?: PlatformDeps;
};

export async function notify({ title, body = "", deps = {} }: NotifyParams): Promise<void> {
  const platform = currentPlatform(deps);
  if (platform === "win32") {
    const escapedTitle = shellQuote(title);
    const escapedBody = shellQuote(body);
    const burntToast = `if (Get-Module -ListAvailable -Name BurntToast) { New-BurntToastNotification -Text ${escapedTitle},${escapedBody}; exit 0 } exit 1`;
    if (await spawnWait({ command: "powershell", args: ["-NoProfile", "-Command", burntToast], deps })) {
      return;
    }
    const fallbackToast = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = '<toast><visual><binding template="ToastGeneric"><text>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text><text>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('looperloop').Show($toast)
`;
    if (await spawnWait({ command: "powershell", args: ["-NoProfile", "-Command", fallbackToast], deps })) {
      return;
    }
    console.log(`${title}${body ? `: ${body}` : ""}`);
    return;
  }
  if (platform === "darwin") {
    if (await spawnWait({ command: "osascript", args: ["-e", `display notification ${appleScriptQuote(body)} with title ${appleScriptQuote(title)}`], deps })) {
      return;
    }
    console.log(`${title}${body ? `: ${body}` : ""}`);
    return;
  }
  if (await spawnWait({ command: "notify-send", args: [title, body], deps })) {
    return;
  }
  console.log(`${title}${body ? `: ${body}` : ""}`);
}

export async function beep(deps: PlatformDeps = {}): Promise<void> {
  const platform = currentPlatform(deps);
  if (platform === "win32") {
    if (await spawnWait({ command: "powershell", args: ["-NoProfile", "-Command", "[console]::beep(880,250)"], deps })) {
      return;
    }
  } else if (platform === "darwin") {
    if (await spawnWait({ command: "afplay", args: ["/System/Library/Sounds/Glass.aiff"], deps })) {
      return;
    }
  } else if (await spawnWait({ command: "paplay", args: ["/usr/share/sounds/freedesktop/stereo/complete.oga"], deps })) {
    return;
  } else if (await spawnWait({ command: "canberra-gtk-play", args: ["-i", "complete"], deps })) {
    return;
  }
  deps.stdout?.write("\u0007") ?? process.stdout.write("\u0007");
}
