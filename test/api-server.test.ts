import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, phaseRunDir, workItemSpecPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem, updateWorkItemStatus } from "../src/storage/work-store.js";
import { writeRunningPhaseRun } from "../src/infra/session-run.js";
import { startApiServer, type ApiServerHandle } from "../src/server/api.js";
import { createDevtaskKernel } from "../src/adapters/agent-kernel/kernel.js";
import { readConfig } from "../src/infra/config.js";

describe("api server", () => {
  const servers: ApiServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves work list, work detail, runs, and session history", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-api-server-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "API server work",
      body: "Check local API surface",
    });
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nServer detail.\n");
    writeRunningPhaseRun(phaseRunDir(paths, item.id, "orchestrate", null), {
      phase: "orchestrate",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-1",
      tmuxSession: "devtask-orchestrate",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: "/tmp/orchestrate.prompt.md",
      outputPath: "/tmp/orchestrate.output.md",
      artifacts: {
        specPath: workItemSpecPath(paths, item.id),
      },
      session: {
        provider: "codex",
        transportId: "devtask-orchestrate",
        resumeContext: {
          providerSessionId: "agent-1",
          conversationId: "thread-1",
          resumeTarget: "agent-1",
          storageRoot: null,
          transcriptPath: null,
        },
        summary: "orchestrate session started",
        summaryIsFallback: true,
      },
      kernelSession: {
        runtimeSessionId: "devtask-orchestrate",
        runtimeName: "tmux",
        threadId: "thread-work-123",
        data: { sessionName: "devtask-orchestrate" },
      },
    });

    const kernel = createDevtaskKernel(paths, readConfig(paths));
    try {
      const thread = kernel.sessionHistory.openThread({
        owner: { type: "work", id: item.id, parent: null },
        labels: { phase: "orchestrate", workId: item.id },
        agentName: "codex",
        runtimeSessionId: "devtask-orchestrate",
        metadata: { workId: item.id, phase: "orchestrate" },
      });
      kernel.sessionHistory.append(thread.id, {
        source: "user",
        category: "message",
        type: "message.sent",
        runtimeSessionId: "devtask-orchestrate",
        payload: { role: "user", text: "Plan the work" },
      });
      kernel.sessionHistory.append(thread.id, {
        source: "agent",
        category: "message",
        type: "message.delta",
        runtimeSessionId: "devtask-orchestrate",
        payload: { role: "assistant", text: "Planning..." },
      });
    } finally {
      kernel.close();
    }

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const server = await startApiServer();
      servers.push(server);

      const workList = await getJson<{ work: Array<{ id: string }> }>(`${server.url}/api/work`);
      expect(workList.work).toEqual([expect.objectContaining({ id: "WORK-123" })]);

      const workDetail = await getJson<{ item: { id: string }; sessions: Array<{ threadId: string }> }>(
        `${server.url}/api/work/WORK-123`,
      );
      expect(workDetail.item.id).toBe("WORK-123");
      expect(workDetail.sessions).toHaveLength(1);

      const runs = await getJson<{ live: Array<{ phase: string }> }>(`${server.url}/api/work/WORK-123/runs`);
      expect(runs.live).toEqual([expect.objectContaining({ phase: "orchestrate" })]);

      const threadId = workDetail.sessions[0]!.threadId;
      const session = await getJson<{ thread: { threadId: string } | null; events: Array<{ type: string }> }>(
        `${server.url}/api/sessions/${encodeURIComponent(threadId)}`,
      );
      expect(session.thread?.threadId).toBe(threadId);
      expect(session.events.some((event) => event.type === "message.delta")).toBe(true);

      const sessionEvents = await getJson<Array<{ type: string }>>(
        `${server.url}/api/sessions/${encodeURIComponent(threadId)}/events?fromSeq=2`,
      );
      expect(sessionEvents[0]?.type).toBe("runtime.attached");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("streams work and session updates over SSE", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-api-stream-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-456",
      title: "Streaming work",
      body: "Observe live updates",
    });
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nInitial.\n");

    const kernel = createDevtaskKernel(paths, readConfig(paths));
    let threadId: string;
    try {
      const thread = kernel.sessionHistory.openThread({
        owner: { type: "work", id: item.id, parent: null },
        labels: { phase: "orchestrate", workId: item.id },
        agentName: "codex",
        runtimeSessionId: "devtask-stream",
        metadata: { workId: item.id, phase: "orchestrate" },
      });
      threadId = thread.id;
    } finally {
      kernel.close();
    }

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const server = await startApiServer();
      servers.push(server);

      const workStream = await fetch(`${server.url}/api/work/WORK-456/stream`);
      expect(workStream.ok).toBe(true);
      const workEvents = createSseReader(workStream);
      const firstWorkEvent = await workEvents.read();
      expect(firstWorkEvent.event).toBe("snapshot");
      expect(firstWorkEvent.data.detail.item.id).toBe("WORK-456");

      updateWorkItemStatus(paths, item.id, "blocked");
      const changedWorkEvent = await workEvents.read({ event: "snapshot" });
      expect(changedWorkEvent.data.detail.item.status).toBe("blocked");

      const sessionStream = await fetch(`${server.url}/api/sessions/${encodeURIComponent(threadId)}/stream`);
      expect(sessionStream.ok).toBe(true);
      const sessionEvents = createSseReader(sessionStream);
      const firstSessionEvent = await sessionEvents.read();
      expect(firstSessionEvent.event).toBe("snapshot");
      expect(firstSessionEvent.data.thread.threadId).toBe(threadId);

      const kernelWriter = createDevtaskKernel(paths, readConfig(paths));
      try {
        kernelWriter.sessionHistory.append(threadId, {
          source: "agent",
          category: "message",
          type: "message.delta",
          runtimeSessionId: "devtask-stream",
          payload: { role: "assistant", text: "Live update" },
        });
      } finally {
        kernelWriter.close();
      }

      const appendedEvent = await sessionEvents.read({ event: "event" });
      expect(appendedEvent.data.type).toBe("message.delta");
      expect(appendedEvent.data.payload.text).toBe("Live update");

      await workEvents.close();
      await sessionEvents.close();
    } finally {
      process.chdir(previousCwd);
    }
  });
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unexpected response ${response.status} for ${url}`);
  }
  return response.json() as Promise<T>;
}

function createSseReader(response: Response): {
  read(options?: { event?: string }): Promise<{ id: string | null; event: string; data: any }>;
  close(): Promise<void>;
} {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async read(options: { event?: string } = {}): Promise<{ id: string | null; event: string; data: any }> {
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) {
            break;
          }
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(chunk);
          if (!parsed) {
            continue;
          }
          if (options.event && parsed.event !== options.event) {
            continue;
          }
          return parsed;
        }
      }

      throw new Error(`Timed out waiting for SSE event${options.event ? ` ${options.event}` : ""}`);
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

function parseSseChunk(chunk: string): { id: string | null; event: string; data: any } | null {
  let id: string | null = null;
  let event = "message";
  const dataLines: string[] = [];

  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    id,
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}
