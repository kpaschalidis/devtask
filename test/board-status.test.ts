import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/infra/tmux.js", () => ({
  tmuxSessionExists: vi.fn(() => false)
}));
import { buildWorkspaceBoardRow } from "../src/board/workspace-board.js";
import { buildWorkBoard } from "../src/board/work-board.js";
import { resolveWorkspacePathsForInit, phaseRunDir } from "../src/infra/paths.js";
import { writePhaseRunRecord, writeRunningPhaseRun } from "../src/infra/phase-run.js";
import { initializeWorkspace, createTask } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { writeTaskMeta } from "../src/storage/meta.js";
import { makeTempRepo } from "./helpers.js";
const tmux = await import("../src/infra/tmux.js");

describe("board status", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(false);
  });
  it("recommends materialize after repo plans exist but before work is materialized", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-workspace-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(
      path.join(paths.workDir, item.id, "graph.json"),
      JSON.stringify({ schemaVersion: 1, workId: item.id, tasks: [], validation: [], openQuestions: [] })
    );
    fs.mkdirSync(path.join(paths.workDir, item.id, "repo-plans"), { recursive: true });
    fs.writeFileSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"), "# Repo Plan\n");

    const row = await buildWorkspaceBoardRow(paths, item);

    expect(row.next).toBe("devtask work materialize WORK-123");
  });

  it("shows execute as the next action for ready materialized repo tasks", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-work-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    const task = await createTask(paths, "work-123-backend", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "backend", "work-123-backend")
    });
    writeTaskMeta(path.join(paths.tasksDir, task.id, "meta.json"), {
      ...task,
      status: "ready",
      updatedAt: new Date().toISOString()
    });
    fs.mkdirSync(path.join(paths.localDir, "work", item.id), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({ schemaVersion: 1, workId: item.id, graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"), materializedAt: new Date().toISOString(), tasks: [{ graphTaskId: task.id, repoId: "backend", repoPath: repo, scope: null, taskId: task.id, branch: task.branch, worktreePath: task.worktreePath }] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");

    const rows = await buildWorkBoard(paths, item.id);

    expect(rows[0]?.next).toBe("devtask work execute WORK-123");
    expect(rows[0]?.status).toBe("ready");
  });

  it("points workspace board next action to the live phase attach command", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-active-phase-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "devtask-orchestrate");
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
        planPath: "/tmp/plan.md"
      },
      session: {
        provider: "codex",
        transportId: "devtask-orchestrate",
        resumeContext: {
          providerSessionId: null,
          conversationId: null,
          resumeTarget: null,
          storageRoot: null,
          transcriptPath: null
        },
        summary: "orchestrate session started",
        summaryIsFallback: true
      }
    });

    const row = await buildWorkspaceBoardRow(paths, item);

    expect(row.next).toBe("devtask work orchestrate attach WORK-123");
  });

  it("shows ci-watch as the next action while CI polling is still in progress", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-ci-watch-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-456",
      title: "Watch CI"
    });
    const task = await createTask(paths, "work-456-backend", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "backend", "work-456-backend")
    });
    writeTaskMeta(path.join(paths.tasksDir, task.id, "meta.json"), {
      ...task,
      status: "done",
      prUrl: "https://github.com/acme/backend/pull/456",
      updatedAt: new Date().toISOString()
    });
    fs.mkdirSync(path.join(paths.localDir, "work", item.id), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({ schemaVersion: 1, workId: item.id, graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"), materializedAt: new Date().toISOString(), tasks: [{ graphTaskId: task.id, repoId: "backend", repoPath: repo, scope: null, taskId: task.id, branch: task.branch, worktreePath: task.worktreePath }] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");
    fs.mkdirSync(path.join(paths.localDir, "work", item.id, "results"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "results", "ci-watch.json"),
      `${JSON.stringify({ workId: item.id, status: "running", generatedAt: new Date().toISOString(), tasks: [{ repoId: "backend", status: "running" }] }, null, 2)}\n`
    );

    const rows = await buildWorkBoard(paths, item.id);

    expect(rows[0]?.status).toBe("ci-running");
    expect(rows[0]?.next).toBe("devtask work ci-watch WORK-456");
  });

  it("shows ci-watch status on the workspace board", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-board-ci-watch-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-789",
      title: "Watch CI from workspace"
    });
    const task = await createTask(paths, "work-789-backend", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "backend", "work-789-backend")
    });
    fs.mkdirSync(path.join(paths.localDir, "work", item.id), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({ schemaVersion: 1, workId: item.id, graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"), materializedAt: "2026-01-01T00:00:00.000Z", tasks: [{ graphTaskId: task.id, repoId: "backend", repoPath: repo, scope: null, taskId: task.id, branch: task.branch, worktreePath: task.worktreePath }] }, null, 2)}\n`
    );
    fs.mkdirSync(path.join(paths.localDir, "work", item.id, "results"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "results", "ci-watch.json"),
      `${JSON.stringify({ workId: item.id, status: "running", generatedAt: "2027-01-02T00:00:00.000Z", tasks: [{ repoId: "backend", status: "running" }] }, null, 2)}\n`
    );

    const row = await buildWorkspaceBoardRow(paths, item);

    expect(row.status).toBe("ci-running");
    expect(row.updatedAt).toBe("2027-01-02T00:00:00.000Z");
  });
});
