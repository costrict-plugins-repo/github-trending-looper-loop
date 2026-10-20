import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveLoopDir, type StatusInput } from "./status";

export type TailInput = StatusInput & {
  lines?: number;
  raw?: boolean;
};

function tail(text: string, lines: number): string {
  return text.replace(/\r\n/g, "\n").split("\n").slice(-lines).join("\n");
}

export async function looperloopTail(input: TailInput): Promise<{ file?: string; text: string }> {
  const dir = await resolveLoopDir(input);
  if (!existsSync(dir)) {
    return { text: "" };
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const iters = entries
    .filter((entry) => entry.isDirectory() && /^iter-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("iter-".length)))
    .sort((a, b) => b - a);
  for (const iter of iters) {
    const iterPath = path.join(dir, `iter-${iter}`);
    const files = await readdir(iterPath);
    const wanted = input.raw ? files.find((file) => file.endsWith(".jsonl") || file.endsWith(".raw.log")) : "worker.log.md";
    if (wanted) {
      const file = path.join(iterPath, wanted);
      if (existsSync(file)) {
        return { file, text: tail(await readFile(file, "utf8"), input.lines ?? 80) };
      }
    }
  }
  return { text: "" };
}
