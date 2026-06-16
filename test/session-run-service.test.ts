import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, phaseRunDir } from "../src/infra/paths.js";
import { writePhaseRunRecord } from "../src/infra/session-run.js";
import { listWorkPhaseRuns, listWorkPhaseSessions, hasWorkPhaseRuns } from "../src/services/session-run-service.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

const SESSION = {
  provider: "codex" as const,
  transportId: "tmux-test",
  resumeContext: {
    providerSessionId: "agent-1",
    conversationId: "thread-1",
    resumeTarget: "agent-1",
    storageRoot: null,
    transcriptPath: null
  },
  summary: null,
  summaryIsFallback: false
};

describe("session-run-service", () => {
  it("listWorkPhaseRuns returns written phase run records", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-session-run-svc-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    writePhaseRunRecord(phaseRunDir(paths, "WORK-1", "orchestrate", null), {
      schemaVersion: 1,
      phase: "orchestrate",
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      repoId: null,
      taskId: null,
      status: "planned",
      promptPath: "/tmp/prompt.md",
      outputPath: "/tmp/output.md",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      session: SESSION,
      artifacts: {},
      exitCode: 0
    });

    const runs = listWorkPhaseRuns(paths, "WORK-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.phase).toBe("orchestrate");
    expect(runs[0]?.status).toBe("planned");
  });

  it("listWorkPhaseSessions returns an empty array when no sessions exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-session-run-svc-empty-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    expect(listWorkPhaseSessions(paths, "WORK-1")).toEqual([]);
  });

  it("hasWorkPhaseRuns returns false when no runs exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-session-run-svc-has-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    expect(hasWorkPhaseRuns(paths, "WORK-1")).toBe(false);
  });
});
