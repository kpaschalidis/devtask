import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { DevtaskError } from "../infra/errors.js";
import { readSessionDetail, readWorkDetail, readWorkList, readWorkRuns } from "./read-models.js";
import { readSessionStreamSnapshot, readWorkDetailStreamSnapshot, readWorkStreamSnapshot } from "./streaming-read-models.js";
import { openSseStream, parseLastEventId, stableJson } from "./sse.js";

export interface StartApiServerOptions {
  host?: string;
  port?: number;
}

export interface ApiServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startApiServer(options: StartApiServerOptions = {}): Promise<ApiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (request, response) => {
    try {
      await handleApiRequest(request, response);
    } catch (error) {
      respondError(response, error);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const value = server.address();
      if (!value || typeof value === "string") {
        reject(new Error("Could not determine API server address"));
        return;
      }
      resolve({ port: value.port });
    });
  });

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
  };
}

async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    throw new DevtaskError(`Unsupported method: ${request.method ?? "unknown"}`);
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const paths = resolveWorkspacePaths();

  if (pathname === "/api/health") {
    return respondJson(response, { ok: true, generatedAt: new Date().toISOString() });
  }

  if (pathname === "/api/work") {
    return respondJson(response, readWorkList(paths));
  }

  if (pathname === "/api/work/stream") {
    return streamWorkList(request, response, paths);
  }

  const workRunsMatch = pathname.match(/^\/api\/work\/([^/]+)\/runs$/);
  if (workRunsMatch) {
    return respondJson(response, readWorkRuns(paths, decodeURIComponent(workRunsMatch[1]!)));
  }

  const workStreamMatch = pathname.match(/^\/api\/work\/([^/]+)\/stream$/);
  if (workStreamMatch) {
    return streamWorkDetail(request, response, paths, decodeURIComponent(workStreamMatch[1]!));
  }

  const workSessionsMatch = pathname.match(/^\/api\/work\/([^/]+)\/sessions$/);
  if (workSessionsMatch) {
    return respondJson(response, readWorkDetail(paths, decodeURIComponent(workSessionsMatch[1]!)).sessions);
  }

  const workMatch = pathname.match(/^\/api\/work\/([^/]+)$/);
  if (workMatch) {
    return respondJson(response, readWorkDetail(paths, decodeURIComponent(workMatch[1]!)));
  }

  const sessionEventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (sessionEventsMatch) {
    const fromSeq = url.searchParams.get("fromSeq");
    const payload = readSessionDetail(
      paths,
      decodeURIComponent(sessionEventsMatch[1]!),
      fromSeq ? Number.parseInt(fromSeq, 10) : undefined,
    );
    return respondJson(response, payload.events);
  }

  const sessionTimelineMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/timeline$/);
  if (sessionTimelineMatch) {
    const payload = readSessionDetail(paths, decodeURIComponent(sessionTimelineMatch[1]!));
    return respondJson(response, payload.timeline);
  }

  const sessionStreamMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
  if (sessionStreamMatch) {
    return streamSession(request, response, paths, decodeURIComponent(sessionStreamMatch[1]!));
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const fromSeq = url.searchParams.get("fromSeq");
    return respondJson(
      response,
      readSessionDetail(
        paths,
        decodeURIComponent(sessionMatch[1]!),
        fromSeq ? Number.parseInt(fromSeq, 10) : undefined,
      ),
    );
  }

  response.statusCode = 404;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ error: `Not found: ${pathname}` }, null, 2)}\n`);
}

function respondJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function streamWorkList(request: IncomingMessage, response: ServerResponse, paths: ReturnType<typeof resolveWorkspacePaths>): void {
  const stream = openSseStream(response);
  let eventId = parseLastEventId(request.headers["last-event-id"]) ?? 0;
  let previous = stableJson(readWorkStreamSnapshot(paths));

  stream.send("snapshot", JSON.parse(previous), String(++eventId));

  const interval = setInterval(() => {
    const currentValue = readWorkStreamSnapshot(paths);
    const current = stableJson(currentValue);
    if (current !== previous) {
      previous = current;
      stream.send("snapshot", currentValue, String(++eventId));
      return;
    }
    stream.heartbeat();
  }, 1000);

  attachStreamCleanup(request, response, interval, stream);
}

function streamWorkDetail(
  request: IncomingMessage,
  response: ServerResponse,
  paths: ReturnType<typeof resolveWorkspacePaths>,
  workId: string,
): void {
  const stream = openSseStream(response);
  let eventId = parseLastEventId(request.headers["last-event-id"]) ?? 0;
  let previous = stableJson(readWorkDetailStreamSnapshot(paths, workId));

  stream.send("snapshot", JSON.parse(previous), String(++eventId));

  const interval = setInterval(() => {
    const currentValue = readWorkDetailStreamSnapshot(paths, workId);
    const current = stableJson(currentValue);
    if (current !== previous) {
      previous = current;
      stream.send("snapshot", currentValue, String(++eventId));
      return;
    }
    stream.heartbeat();
  }, 1000);

  attachStreamCleanup(request, response, interval, stream);
}

function streamSession(
  request: IncomingMessage,
  response: ServerResponse,
  paths: ReturnType<typeof resolveWorkspacePaths>,
  threadId: string,
): void {
  const stream = openSseStream(response);
  const lastEventIdHeader = parseLastEventId(request.headers["last-event-id"]);
  const initialDetail = readSessionDetail(paths, threadId);
  const currentSeq = initialDetail.events.reduce((max, event) => Math.max(max, event.seq), 0);
  let nextSeq = lastEventIdHeader ? lastEventIdHeader + 1 : currentSeq + 1;
  let previousSnapshot = stableJson(readSessionStreamSnapshot(paths, threadId));

  stream.send("snapshot", JSON.parse(previousSnapshot), String(lastEventIdHeader ?? currentSeq));

  const interval = setInterval(() => {
    const detail = readSessionDetail(paths, threadId, nextSeq);
    for (const event of detail.events) {
      stream.send("event", event, String(event.seq));
      nextSeq = Math.max(nextSeq, event.seq + 1);
    }

    const snapshotValue = readSessionStreamSnapshot(paths, threadId);
    const snapshot = stableJson(snapshotValue);
    if (snapshot !== previousSnapshot) {
      previousSnapshot = snapshot;
      const snapshotId = nextSeq > 1 ? String(nextSeq - 1) : "1";
      stream.send("snapshot", snapshotValue, snapshotId);
      return;
    }

    stream.heartbeat();
  }, 1000);

  attachStreamCleanup(request, response, interval, stream);
}

function attachStreamCleanup(
  request: IncomingMessage,
  response: ServerResponse,
  interval: NodeJS.Timeout,
  stream: ReturnType<typeof openSseStream>,
): void {
  const cleanup = () => {
    clearInterval(interval);
    stream.close();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
}

function respondError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown server error";
  const statusCode = error instanceof DevtaskError ? 400 : 500;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ error: message }, null, 2)}\n`);
}
