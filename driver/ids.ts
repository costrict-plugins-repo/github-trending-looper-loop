import { existsSync } from "node:fs";
import path from "node:path";
import adjectives from "../data/adjectives.json";
import animals from "../data/animals.json";
import { loopRoot } from "./paths";

function pick(values: string[]): string {
  return values[Math.floor(Math.random() * values.length)]!;
}

function suffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return bytes[0]!.toString(16).padStart(2, "0");
}

export function createLoopId(workspaceDir: string): string {
  const root = loopRoot(workspaceDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `loop-${pick(adjectives)}-${pick(animals)}`;
    if (!existsSync(path.join(root, id))) {
      return id;
    }
  }
  return `loop-${pick(adjectives)}-${pick(animals)}-${suffix()}`;
}
