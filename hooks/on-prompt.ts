import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const seenFile = path.join(os.homedir(), ".looperloop", "seen.json");

async function readSeen(file = seenFile): Promise<Record<string, true>> {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, true>;
  } catch {
    return {};
  }
}

async function writeSeen(seen: Record<string, true>, file = seenFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(seen, null, 2)}\n`, "utf8");
}

export async function collectCompletionContext(cwd = process.cwd(), seenPath = seenFile): Promise<string> {
  const root = path.join(cwd, "looper", "loop-runs");
  if (!existsSync(root)) {
    return "";
  }
  const seen = await readSeen(seenPath);
  const dirs = await readdir(root, { withFileTypes: true });
  const lines: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const complete = path.join(root, dir.name, "COMPLETE");
    const result = path.join(root, dir.name, "RESULT.json");
    if (!existsSync(complete) || seen[complete]) {
      continue;
    }
    let outcome = "finished";
    try {
      const parsed = JSON.parse(await readFile(result, "utf8")) as { outcome?: string };
      outcome = parsed.outcome ?? outcome;
    } catch {
      outcome = (await readFile(complete, "utf8")).trim() || outcome;
    }
    lines.push(`Loop ${dir.name} finished: ${outcome}. See ${result}`);
    seen[complete] = true;
  }
  await writeSeen(seen, seenPath);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const additionalContext = await collectCompletionContext();
  if (additionalContext.length) {
    console.log(
      JSON.stringify({
        additionalContext,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      }),
    );
  }
}

if (import.meta.main) {
  await main();
}
