import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/infra/tmux.js", () => ({
  createBareSession: vi.fn(),
  sendLaunchCommand: vi.fn(),
  tmuxSessionExists: vi.fn(() => false),
  tmuxSessionName: vi.fn((_paths, taskId: string) => `devtask-test-${taskId}`),
  waitForTmuxSession: vi.fn(() => true),
  writeLaunchScript: vi.fn(() => "/tmp/devtask-launch.sh")
}));

import { resolvePaths, resolveWorkspacePathsForInit, taskMetaPath } from "../src/infra/paths.js";
import { writeConfig } from "../src/infra/config.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan } from "../src/work-materializer.js";
import { workItemGraphPath } from "../src/infra/paths.js";
import { getLatestWorkPhaseRun } from "../src/services/session-run-service.js";
import { executeWork } from "../src/services/work-service.js";
import { readTaskMeta } from "../src/storage/meta.js";
import { getWorkItem } from "../src/storage/work-store.js";
import { makeTempRepo } from "./helpers.js";

const tmux = await import("../src/infra/tmux.js");

describe("work execute", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(false);
    vi.mocked(tmux.waitForTmuxSession).mockReturnValue(true);
    vi.mocked(tmux.writeLaunchScript).mockReturnValue("/tmp/devtask-launch.sh");
  });

  it("starts a new execution session for a materialized task", async () => {
    const { paths, repo } = await createMaterializedWork();
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "devtask-test-work-123-backend");

    const result = await executeWork(paths, "WORK-123");

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      repoId: "backend",
      taskId: "work-123-backend",
      status: "running",
      action: "started",
      sessionName: "devtask-test-work-123-backend"
    });
    expect(tmux.createBareSession).toHaveBeenCalled();
    expect(tmux.sendLaunchCommand).toHaveBeenCalled();

    const meta = readTaskMeta(taskMetaPath(paths, "work-123-backend"));
    expect(meta.status).toBe("running");
    expect(meta.tmuxSession).toBe("devtask-test-work-123-backend");
    expect(meta.resultSummary).toBe("execution session started");
    expect(getWorkItem(paths, "WORK-123").status).toBe("executing");
  });

  it("reattaches to an existing active execution session", async () => {
    const { paths, repo } = await createMaterializedWork();
    const metaPath = taskMetaPath(paths, "work-123-backend");
    const initial = readTaskMeta(metaPath);
    fs.writeFileSync(
      metaPath,
      `${JSON.stringify({ ...initial, status: "running", tmuxSession: "existing-session", updatedAt: new Date().toISOString() }, null, 2)}\n`
    );
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "existing-session");

    const result = await executeWork(paths, "WORK-123");

    expect(result.tasks[0]).toMatchObject({
      status: "running",
      action: "reattached",
      sessionName: "existing-session"
    });
    expect(tmux.createBareSession).not.toHaveBeenCalled();
  });

  it("persists terminal blocked results without launching a new session", async () => {
    const { paths, repo } = await createMaterializedWork();
    const meta = readTaskMeta(taskMetaPath(paths, "work-123-backend"));
    fs.writeFileSync(meta.resultPath, `${JSON.stringify({ status: "blocked", reason: "waiting for API contract" }, null, 2)}\n`);

    const result = await executeWork(paths, "WORK-123");

    expect(result.tasks[0]).toMatchObject({
      status: "blocked",
      action: "skipped",
      summary: "waiting for API contract"
    });
    const updated = readTaskMeta(taskMetaPath(paths, "work-123-backend"));
    expect(updated.status).toBe("blocked");
    expect(updated.resultSummary).toBe("waiting for API contract");
    expect(tmux.createBareSession).not.toHaveBeenCalled();
    expect(getWorkItem(paths, "WORK-123").status).toBe("blocked");
  });

  it("writes execute session records with the configured provider", async () => {
    const { paths } = await createMaterializedWork();
    writeConfig(paths, {
      schemaVersion: 1,
      tracker: { provider: null },
      scm: { provider: null },
      agent: { provider: "cursor" },
      agentSessions: { roots: { codex: null, cursor: null } },
      codex: { model: null, fullAuto: true },
      runtime: { mode: "attachable", backend: "tmux" },
      runtimeConfigured: false,
      jira: { baseUrl: null, email: null, cloudId: null },
      verify: []
    });
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "devtask-test-work-123-backend");

    await executeWork(paths, "WORK-123");

    expect(getLatestWorkPhaseRun(paths, "WORK-123", "execute", "backend")?.session.provider).toBe("cursor");
  });
});

async function createMaterializedWork(): Promise<{ paths: ReturnType<typeof resolveWorkspacePathsForInit>; repo: string }> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-execute-"));
  const repo = await makeTempRepo({ withCommit: true });
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  const item = createManualWorkItem(paths, {
    id: "WORK-123",
    title: "Add API behavior"
  });
  addWorkspaceRepo(paths, {
    id: "backend",
    repoPath: repo,
    kind: "api"
  });
  fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
  fs.writeFileSync(
    workItemGraphPath(paths, item.id),
    JSON.stringify(
      {
        schemaVersion: 1,
        workId: item.id,
        tasks: [
          {
            id: "work-123-backend",
            repoId: "backend",
            goal: "Implement backend behavior.",
            owns: ["server/**"],
            dependencies: []
          }
        ],
        validation: [],
        openQuestions: []
      },
      null,
      2
    )
  );
  await materializeWorkPlan(paths, item);
  return { paths, repo };
}
