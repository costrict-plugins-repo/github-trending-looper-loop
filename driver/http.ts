import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readPreviewGraph } from "./branches/graph";
import { LoopStatus, readActivityHistory, readState, stopPath, updateState } from "./state";

export type StatusServer = {
  port: number;
  url: string;
  close: () => void;
  broadcast: () => Promise<void>;
};

const STATUS_PORT_START = 47000;
const STATUS_PORT_END = 65535;

async function findPort(): Promise<number> {
  for (let port = STATUS_PORT_START; port <= STATUS_PORT_END; port += 1) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("ok") });
      server.stop(true);
      return port;
    } catch {
      // Port in use; try the next one.
    }
  }
  throw new Error(`No free status port in ${STATUS_PORT_START}-${STATUS_PORT_END}`);
}

export async function startStatusServer(loopDir: string): Promise<StatusServer> {
  const port = await findPort();
  const uiDir = path.resolve(import.meta.dir, "..", "ui");
  const loopId = path.basename(loopDir);
  const runBasePath = `/runs/${encodeURIComponent(loopId)}/`;

  function responseForRunPath(url: URL): { kind: "root" } | { kind: "not-found" } | { kind: "ok"; relativePath: string } {
    if (url.pathname === "/") {
      return { kind: "root" };
    }
    if (!url.pathname.startsWith(runBasePath)) {
      return { kind: "not-found" };
    }
    return { kind: "ok", relativePath: url.pathname.slice(runBasePath.length).replace(/^\/+/, "") };
  }

  async function stateResponse(): Promise<Response> {
    return Response.json(await readState(loopDir));
  }

  async function activityResponse(): Promise<Response> {
    return Response.json({ activity: await readActivityHistory(loopDir) });
  }

  async function graphResponse(): Promise<Response> {
    return Response.json(await readPreviewGraph(loopDir));
  }

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const runPath = responseForRunPath(url);
      if (runPath.kind === "root") {
        return Response.redirect(`http://localhost:${port}${runBasePath}`, 302);
      }
      if (runPath.kind === "not-found") {
        return new Response("Run is not served by this status server", { status: 404 });
      }
      const route = runPath.relativePath;
      if (route === "state") {
        return stateResponse();
      }
      if (route === "activity") {
        return activityResponse();
      }
      if (route === "graph") {
        return graphResponse();
      }
      if (route === "stop" && request.method === "POST") {
        await Bun.write(stopPath(loopDir), "stop\n");
        await updateState(loopDir, { status: LoopStatus.Cancelling, currentActor: "cancelling", lastVerdict: "cancelling" });
        await broadcast();
        return Response.json({ ok: true });
      }
      const file = route === "" ? path.join(uiDir, "index.html") : path.resolve(uiDir, route);
      if (!file.startsWith(`${uiDir}${path.sep}`) && file !== path.join(uiDir, "index.html")) {
        return new Response("Not found", { status: 404 });
      }
      if (existsSync(file)) {
        const content = await readFile(file);
        const type = file.endsWith(".js") ? "text/javascript" : "text/html";
        return new Response(content, { headers: { "content-type": type } });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  async function broadcast(): Promise<void> {}

  return {
    port,
    url: `http://localhost:${port}${runBasePath}`,
    close: () => server.stop(true),
    broadcast,
  };
}
