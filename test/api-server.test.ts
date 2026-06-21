import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, phaseRunDir, workItemSpecPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { writeRunningPhaseRun } from "../src/infra/session-run.js";
import { startApiServer, type ApiServerHandle } from "../src/server/api.js";
import { createDevtaskKernel } from "../src/kernel/devtask-kernel.js";
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
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unexpected response ${response.status} for ${url}`);
  }
  return response.json() as Promise<T>;
}
