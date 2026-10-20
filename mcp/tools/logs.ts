import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveLoopDir, type StatusInput } from "./status";

export type LogsInput = StatusInput & {
  iter?: number;
};

export async function looperloopLogs(input: LogsInput): Promise<{ files: string[]; markdown: Record<string, string>; raw: string[] }> {
  const dir = await resolveLoopDir(input);
  const target = input.iter ? path.join(dir, `iter-${input.iter}`) : dir;
  if (!existsSync(target)) {
    return { files: [], markdown: {}, raw: [] };
  }
  const entries = await readdir(target, { recursive: true });
  const files = entries.map((entry) => path.join(target, String(entry))).filter((file) => existsSync(file));
  const markdownFiles = files.filter((file) => file.endsWith(".md"));
  const raw = files.filter((file) => file.endsWith(".jsonl") || file.endsWith(".raw.log") || file.endsWith(".stderr.log"));
  const markdown: Record<string, string> = {};
  for (const file of markdownFiles) {
    markdown[file] = await readFile(file, "utf8");
  }
  return { files, markdown, raw };
}
