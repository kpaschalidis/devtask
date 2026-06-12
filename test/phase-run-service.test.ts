import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, workItemPhaseRunsDir, workItemRepoPhaseRunsDir } from "../src/infra/paths.js";
import { writePhaseRunRecord } from "../src/infra/phase-run.js";
import { getLatestWorkPhaseRun, listWorkPhaseRuns } from "../src/services/phase-run-service.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

describe("phase run service", () => {
  it("lists work phase runs across work and repo scoped phases", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-run-service-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    writePhaseRunRecord(workItemPhaseRunsDir(paths, "WORK-1", "spec"), {
      schemaVersion: 1,
      phase: "spec",
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      repoId: null,
      taskId: null,
      status: "spec-ready",
      promptPath: "/tmp/spec.prompt.md",
      outputPath: "/tmp/spec.output.md",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-spec",
        providerSessionId: "agent-spec",
        conversationId: "thread-spec",
        resumeTarget: "agent-spec",
        storageRoot: null,
        transcriptPath: null,
        summary: "spec complete",
        summaryIsFallback: false
      },
      artifacts: {
        specPath: "/tmp/spec.md"
      },
      exitCode: 0
    });
    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, "WORK-1", "repo-plan", "backend"), {
      schemaVersion: 1,
      phase: "repo-plan",
      runId: "2026-01-01T00-00-01-000Z",
      workId: "WORK-1",
      repoId: "backend",
      taskId: "work-1-backend",
      status: "planned",
      promptPath: "/tmp/backend-repo-plan.prompt.md",
      outputPath: "/tmp/backend-repo-plan.output.md",
      startedAt: "2026-01-01T00:00:03.000Z",
      finishedAt: "2026-01-01T00:00:04.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-backend",
        providerSessionId: "agent-backend",
        conversationId: "thread-backend",
        resumeTarget: "agent-backend",
        storageRoot: null,
        transcriptPath: null,
        summary: "repo plan complete",
        summaryIsFallback: false
      },
      artifacts: {
        planPath: "/tmp/backend-plan.md"
      },
      exitCode: 0
    });
    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, "WORK-1", "execute", "frontend"), {
      schemaVersion: 1,
      phase: "execute",
      runId: "2026-01-01T00-00-02-000Z",
      workId: "WORK-1",
      repoId: "frontend",
      taskId: "work-1-frontend",
      status: "running",
      promptPath: "/tmp/frontend-execute.prompt.md",
      outputPath: "/tmp/frontend-execute.output.md",
      startedAt: "2026-01-01T00:00:05.000Z",
      finishedAt: "2026-01-01T00:00:06.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-frontend",
        providerSessionId: "agent-frontend",
        conversationId: "thread-frontend",
        resumeTarget: "agent-frontend",
        storageRoot: null,
        transcriptPath: null,
        summary: "frontend running",
        summaryIsFallback: true
      },
      artifacts: {
        resultPath: "/tmp/frontend-result.json"
      },
      exitCode: null
    });

    const runs = listWorkPhaseRuns(paths, "WORK-1");

    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.runId)).toEqual([
      "2026-01-01T00-00-02-000Z",
      "2026-01-01T00-00-01-000Z",
      "2026-01-01T00-00-00-000Z"
    ]);
    expect(runs[0]?.repoId).toBe("frontend");
    expect(runs[1]?.taskId).toBe("work-1-backend");
    expect(runs[2]?.artifacts.specPath).toBe("/tmp/spec.md");
  });

  it("filters latest runs by phase and repo", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-run-service-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, "WORK-1", "execute", "backend"), {
      schemaVersion: 1,
      phase: "execute",
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      repoId: "backend",
      taskId: "work-1-backend",
      status: "running",
      promptPath: "/tmp/old.prompt.md",
      outputPath: "/tmp/old.output.md",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-old",
        providerSessionId: null,
        conversationId: null,
        resumeTarget: null,
        storageRoot: null,
        transcriptPath: null,
        summary: null,
        summaryIsFallback: null
      },
      artifacts: {
        resultPath: "/tmp/old-result.json"
      },
      exitCode: null
    });
    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, "WORK-1", "execute", "backend"), {
      schemaVersion: 1,
      phase: "execute",
      runId: "2026-01-01T00-00-01-000Z",
      workId: "WORK-1",
      repoId: "backend",
      taskId: "work-1-backend",
      status: "done",
      promptPath: "/tmp/new.prompt.md",
      outputPath: "/tmp/new.output.md",
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-new",
        providerSessionId: "agent-new",
        conversationId: "thread-new",
        resumeTarget: "agent-new",
        storageRoot: null,
        transcriptPath: null,
        summary: "done",
        summaryIsFallback: false
      },
      artifacts: {
        resultPath: "/tmp/new-result.json"
      },
      exitCode: 0
    });
    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, "WORK-1", "review", "backend"), {
      schemaVersion: 1,
      phase: "review",
      runId: "2026-01-01T00-00-02-000Z",
      workId: "WORK-1",
      repoId: "backend",
      taskId: "work-1-backend",
      status: "approved",
      promptPath: "/tmp/review.prompt.md",
      outputPath: "/tmp/review.output.md",
      startedAt: "2026-01-01T00:00:04.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
      session: {
        provider: "codex",
        transportId: "tmux-review",
        providerSessionId: "agent-review",
        conversationId: "thread-review",
        resumeTarget: "agent-review",
        storageRoot: null,
        transcriptPath: null,
        summary: "approved",
        summaryIsFallback: false
      },
      artifacts: {
        reviewPath: "/tmp/review.json"
      },
      exitCode: 0
    });

    expect(listWorkPhaseRuns(paths, "WORK-1", { latest: true })).toHaveLength(2);
    expect(getLatestWorkPhaseRun(paths, "WORK-1", "execute", "backend")?.status).toBe("done");
    expect(listWorkPhaseRuns(paths, "WORK-1", { phase: "execute", repoId: "backend" }).map((run) => run.status)).toEqual([
      "done",
      "running"
    ]);
  });
});
