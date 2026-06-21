import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { DevtaskError } from "../infra/errors.js";
import { readSessionDetail, readWorkDetail, readWorkList, readWorkRuns } from "./read-models.js";

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
  const server = http.createServer(async (request, response) => {
    try {
      await handleApiRequest(request, response);
    } catch (error) {
      respondError(response, error);
    }
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

  const workMatch = pathname.match(/^\/api\/work\/([^/]+)$/);
  if (workMatch) {
    return respondJson(response, readWorkDetail(paths, decodeURIComponent(workMatch[1]!)));
  }

  const workRunsMatch = pathname.match(/^\/api\/work\/([^/]+)\/runs$/);
  if (workRunsMatch) {
    return respondJson(response, readWorkRuns(paths, decodeURIComponent(workRunsMatch[1]!)));
  }

  const workSessionsMatch = pathname.match(/^\/api\/work\/([^/]+)\/sessions$/);
  if (workSessionsMatch) {
    return respondJson(response, readWorkDetail(paths, decodeURIComponent(workSessionsMatch[1]!)).sessions);
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

  response.statusCode = 404;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ error: `Not found: ${pathname}` }, null, 2)}\n`);
}

function respondJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function respondError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown server error";
  const statusCode = error instanceof DevtaskError ? 400 : 500;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify({ error: message }, null, 2)}\n`);
}
