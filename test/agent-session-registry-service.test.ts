import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeAgentSessionRegistryEntry } from "../src/infra/agent-session-registry.js";
import { resolveWorkspacePathsForInit, workItemSessionRegistryDir } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { listWorkAgentSessions } from "../src/services/agent-session-registry-service.js";

describe("agent session registry service", () => {
  it("lists persisted session entries and can reduce to the latest per scope", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-agent-session-registry-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, {
      id: "WORK-1",
      title: "Registry test"
    });

    const dir = workItemSessionRegistryDir(paths, "WORK-1");
    writeAgentSessionRegistryEntry(dir, {
      schemaVersion: 1,
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      phase: "repo-plan",
      repoId: "backend",
      taskId: "task-1",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      session: {
        provider: "codex",
        transportId: "transport-1",
        providerSessionId: "provider-1",
        conversationId: "conversation-1",
        resumeTarget: "resume-1",
        storageRoot: "/tmp/root-1",
        transcriptPath: "/tmp/transcript-1.jsonl",
        summary: "first",
        summaryIsFallback: false
      }
    });
    writeAgentSessionRegistryEntry(dir, {
      schemaVersion: 1,
      runId: "2026-01-01T00-00-01-000Z",
      workId: "WORK-1",
      phase: "repo-plan",
      repoId: "backend",
      taskId: "task-1",
      status: "planned",
      startedAt: "2026-01-01T00:00:11.000Z",
      finishedAt: "2026-01-01T00:00:20.000Z",
      session: {
        provider: "codex",
        transportId: "transport-2",
        providerSessionId: "provider-2",
        conversationId: "conversation-2",
        resumeTarget: "resume-2",
        storageRoot: "/tmp/root-2",
        transcriptPath: "/tmp/transcript-2.jsonl",
        summary: "second",
        summaryIsFallback: false
      }
    });
    writeAgentSessionRegistryEntry(dir, {
      schemaVersion: 1,
      runId: "2026-01-01T00-00-02-000Z",
      workId: "WORK-1",
      phase: "spec",
      repoId: null,
      taskId: null,
      status: "spec-ready",
      startedAt: "2026-01-01T00:00:21.000Z",
      finishedAt: "2026-01-01T00:00:25.000Z",
      session: {
        provider: "codex",
        transportId: "transport-3",
        providerSessionId: "provider-3",
        conversationId: "conversation-3",
        resumeTarget: "resume-3",
        storageRoot: "/tmp/root-3",
        transcriptPath: "/tmp/transcript-3.jsonl",
        summary: "third",
        summaryIsFallback: false
      }
    });

    const all = listWorkAgentSessions(paths, "WORK-1");
    const latest = listWorkAgentSessions(paths, "WORK-1", { latest: true });

    expect(all).toHaveLength(3);
    expect(all[0]?.runId).toBe("2026-01-01T00-00-02-000Z");
    expect(latest).toHaveLength(2);
    expect(latest.find((entry) => entry.phase === "repo-plan")?.status).toBe("planned");
    expect(latest.find((entry) => entry.phase === "repo-plan")?.session.resumeTarget).toBe("resume-2");
  });
});
