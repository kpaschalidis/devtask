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
    fs.writeFileSync(path.join(paths.workDir, item.id, "spec.md"), "# Spec\n");
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(paths.workDir, item.id, "repo-plans"), { recursive: true });
    fs.writeFileSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"), "# Repo Plan\n");
    writePhaseRunRecord(phaseRunDir(paths, item.id, "plan", null), {
      schemaVersion: 1,
      phase: "plan",
      runId: "2026-01-01T00-00-00-000Z",
      workId: item.id,
      repoId: null,
      taskId: null,
      status: "planned",
      promptPath: "p",
      outputPath: "o",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0,
      session: { provider: "codex", transportId: null, resumeContext: { providerSessionId: null, conversationId: null, resumeTarget: null, storageRoot: null, transcriptPath: null }, summary: null, summaryIsFallback: null },
      artifacts: { planPath: "p", graphPath: "g" }
    });

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
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "devtask-spec");
    writeRunningPhaseRun(phaseRunDir(paths, item.id, "spec", null), {
      phase: "spec",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-1",
      tmuxSession: "devtask-spec",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: "/tmp/spec.prompt.md",
      outputPath: "/tmp/spec.output.md",
      artifacts: {
        specPath: "/tmp/spec.md"
      },
      session: {
        provider: "codex",
        transportId: "devtask-spec",
        resumeContext: {
          providerSessionId: null,
          conversationId: null,
          resumeTarget: null,
          storageRoot: null,
          transcriptPath: null
        },
        summary: "spec session started",
        summaryIsFallback: true
      }
    });

    const row = await buildWorkspaceBoardRow(paths, item);

    expect(row.next).toBe("devtask work spec attach WORK-123");
  });
});
