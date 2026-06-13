import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { resolveWorkspacePaths } from "../infra/paths.js";
import {
  loadBoardIndexData,
  loadWorkspaceBoardPage,
  renderIndexHtml,
  renderWorkspaceBoardHtml
} from "./html.js";
import { getWorkspaceById } from "../services/workspace-service.js";

export interface StartBoardServerOptions {
  workspaceId?: string;
  host?: string;
  port?: number;
}

export interface BoardServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startBoardServer(options: StartBoardServerOptions = {}): Promise<BoardServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response, options.workspaceId);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(error instanceof Error ? error.message : "Unknown server error");
    }
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const value = server.address();
      if (!value || typeof value === "string") {
        reject(new Error("Could not determine board server address"));
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
      })
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, workspaceId?: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/") {
    const data = await loadBoardIndexData(workspaceId ?? url.searchParams.get("workspace") ?? undefined);
    respondHtml(response, renderIndexHtml(data.entries, data.generatedAt, { live: true, workspaceId }));
    return;
  }

  if (pathname === "/api/index") {
    const data = await loadBoardIndexData(workspaceId ?? url.searchParams.get("workspace") ?? undefined);
    respondJson(response, data);
    return;
  }

  if (pathname.startsWith("/api/workspaces/")) {
    const targetWorkspaceId = decodeURIComponent(pathname.slice("/api/workspaces/".length));
    const target = getWorkspaceById(targetWorkspaceId);
    const data = await loadWorkspaceBoardPage(resolveWorkspacePaths(target.path), new Date().toISOString());
    respondJson(response, data);
    return;
  }

  if (pathname.startsWith("/workspaces/")) {
    const targetWorkspaceId = decodeURIComponent(pathname.slice("/workspaces/".length));
    const normalizedWorkspaceId = targetWorkspaceId.replace(/\.html$/, "");
    const target = getWorkspaceById(normalizedWorkspaceId);
    const data = await loadWorkspaceBoardPage(resolveWorkspacePaths(target.path), new Date().toISOString());
    respondHtml(response, renderWorkspaceBoardHtml(data, { live: true }));
    return;
  }

  if (pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }

  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(`Not found: ${path.normalize(pathname)}`);
}

function respondHtml(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

function respondJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}
