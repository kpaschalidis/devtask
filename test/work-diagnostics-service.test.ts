import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace, createTask } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { writeTaskMeta } from "../src/storage/meta.js";
import { getWorkDiagnostics } from "../src/services/work-diagnostics-service.js";
import { makeTempRepo } from "./helpers.js";

describe("work diagnostics service", () => {
  it("explains that unmaterialized work is waiting on materialization after repo plans exist", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-diagnostics-"));
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

    const diagnostic = getWorkDiagnostics(paths, item.id);

    expect(diagnostic.waitingOn).toBe("materialization");
    expect(diagnostic.next).toBe("devtask work materialize WORK-123");
    expect(diagnostic.reason).toContain("Repo plans exist");
    expect(diagnostic.missingArtifacts).toContain("local/work/<work-id>/materialization.json");
  });

  it("explains paused repo tasks as waiting on execution resume", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-diagnostics-"));
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
      status: "paused",
      runtime: {
        state: "missing",
        reason: "recorded tmux session devtask-backend is not running",
        lastObservedAt: "2026-01-01T00:00:10.000Z"
      },
      updatedAt: "2026-01-01T00:00:11.000Z"
    });
    fs.mkdirSync(path.join(paths.localDir, "work", item.id), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({ schemaVersion: 1, workId: item.id, graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"), materializedAt: new Date().toISOString(), tasks: [{ graphTaskId: task.id, repoId: "backend", repoPath: repo, scope: null, taskId: task.id, branch: task.branch, worktreePath: task.worktreePath }] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");

    const diagnostic = getWorkDiagnostics(paths, item.id);

    expect(diagnostic.waitingOn).toBe("execution");
    expect(diagnostic.next).toBe("devtask work execute WORK-123");
    expect(diagnostic.tasks[0]).toMatchObject({
      repoId: "backend",
      waitingOn: "execution",
      next: "devtask work execute WORK-123",
      reason: "recorded tmux session devtask-backend is not running"
    });
  });

  it("points review wait state at the stored review result path", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-diagnostics-"));
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
      status: "done",
      updatedAt: "2026-01-01T00:00:11.000Z"
    });
    fs.mkdirSync(path.join(paths.localDir, "work", item.id), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({ schemaVersion: 1, workId: item.id, graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"), materializedAt: new Date().toISOString(), tasks: [{ graphTaskId: task.id, repoId: "backend", repoPath: repo, scope: null, taskId: task.id, branch: task.branch, worktreePath: task.worktreePath }] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");

    const diagnostic = getWorkDiagnostics(paths, item.id);

    expect(diagnostic.waitingOn).toBe("review");
    expect(diagnostic.missingArtifacts).toContain("reviews/backend.json");
    expect(diagnostic.tasks[0]?.missingArtifacts).toContain("reviews/backend.json");
  });
});
