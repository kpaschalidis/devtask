import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planMarkdownPath, resolvePaths, resolveWorkspacePathsForInit, taskMetaPath } from "../src/paths.js";
import { readTaskMeta, writeTaskMeta } from "../src/meta.js";
import { recordStage } from "../src/stage-contracts.js";
import { recordWorkStage } from "../src/work-stage-contracts.js";
import { initializeWorkspace } from "../src/task-store.js";
import { buildWorkBoardRows } from "../src/work-board.js";
import { approveWorkPlan, readWorkMaterialization } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import { createManualWorkItem } from "../src/work-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("work board", () => {
  it("shows the work planning next step before a graph exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-plan-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Plan work"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "-",
        task: "WORK-123",
        stage: "spec",
        status: "pending",
        last: "-",
        blocked: "workspace plan is missing",
        next: "devtask work spec WORK-123"
      })
    ]);
  });

  it("shows failed workspace planning explicitly before materialization", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-plan-failed-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Plan work"
    });
    recordWorkStage(paths, item.id, "plan", {
      status: "failed",
      reason: "planner exited without producing valid plan artifacts",
      artifacts: [path.join(workspace, ".devtask", "work", item.id, "plans", "latest.md")]
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "-",
        task: "WORK-123",
        stage: "spec",
        status: "failed",
        last: "plan failed",
        blocked: "planner exited without producing valid plan artifacts",
        next: "devtask work spec WORK-123 --refresh"
      })
    ]);
  });

  it("shows the spec next step after a graph exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-approve-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Plan work"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "-",
        task: "WORK-123",
        stage: "spec",
        status: "pending",
        next: "devtask work spec WORK-123"
      })
    ]);
  });

  it("does not recommend approval for a graph without a human-readable plan", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-graph-only-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Plan work"
    });
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        stage: "spec",
        next: "devtask work spec WORK-123"
      })
    ]);
  });

  it("shows materialized repo-local task state with work-level next commands", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-materialized-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: ["npm test"],
          openQuestions: []
        },
        null,
        2
      )
    );
    await approveWorkPlan(paths, item);

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "repo-plan",
        status: "missing",
        blocked: "repo plan is missing",
        next: "devtask work spec WORK-123"
      })
    ]);
  });

  it("shows running repo planning as spec progress instead of approval-ready", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-repo-planning-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
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
    await approveWorkPlan(paths, item);
    const materialization = readWorkMaterialization(paths, item.id);
    if (!materialization) {
      throw new Error("Expected materialization");
    }
    const task = materialization.tasks[0];
    const repoPaths = resolvePaths(task.repoPath);
    recordStage(repoPaths, task.taskId, "plan", {
      status: "running",
      reason: "repo planning is running"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "repo-plan",
        status: "running",
        blocked: "repo planning is running",
        next: "devtask work board WORK-123"
      })
    ]);
  });

  it("uses work-level running repo-plan state before task ledgers are written", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-work-repo-planning-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
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
    await approveWorkPlan(paths, item);
    recordWorkStage(paths, item.id, "repo-plan", {
      status: "running",
      reason: "repo planning is running"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "repo-plan",
        status: "missing",
        blocked: "repo plan is missing",
        next: "devtask work spec WORK-123"
      })
    ]);
  });

  it("shows work-level run commands, latest results, and dependency waiting state", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-dependencies-"));
    const backendRepo = await makeTempRepo({ withCommit: true });
    const frontendRepo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: backendRepo,
      kind: "api"
    });
    addWorkspaceTarget(paths, {
      id: "frontend",
      repoPath: frontendRepo,
      kind: "web"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            },
            {
              id: "work-123-frontend",
              target: "frontend",
              goal: "Implement frontend behavior.",
              owns: ["src/**"],
              dependencies: [{ task: "work-123-backend", type: "run", reason: "Backend must finish before frontend starts." }]
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );
    await approveWorkPlan(paths, item);
    markMaterializedTasksPlanned(paths, item.id);

    const rows = await buildWorkBoardRows(paths, item);

    expect(rows).toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "run",
        status: "ready",
        last: "plan passed",
        blocked: "-",
        next: "devtask work exec WORK-123 --auto"
      }),
      expect.objectContaining({
        target: "frontend",
        task: "work-123-frontend",
        stage: "run",
        status: "waiting",
        last: "plan passed",
        blocked: "waiting for work-123-backend",
        next: "waiting for work-123-backend"
      })
    ]);
  });

  it("shows completed run tasks as ready for work-level checks", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-run-complete-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
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
    await approveWorkPlan(paths, item);
    markMaterializedTasksPlanned(paths, item.id);
    const materialization = readWorkMaterialization(paths, item.id);
    if (!materialization) {
      throw new Error("Expected materialization");
    }
    const task = materialization.tasks[0];
    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
      ...meta,
      status: "done"
    });
    recordStage(repoPaths, task.taskId, "run", {
      status: "passed",
      startedAt: "2027-05-05T00:00:00.000Z",
      finishedAt: "2027-05-05T00:00:01.000Z"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "check",
        status: "pending",
        last: "run passed",
        blocked: "-",
        next: "devtask work exec WORK-123 --auto"
      })
    ]);
  });

  it("routes pending CI to the work-level ci command", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-ci-pending-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
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
    await approveWorkPlan(paths, item);
    markMaterializedTasksPlanned(paths, item.id);
    const materialization = readWorkMaterialization(paths, item.id);
    if (!materialization) {
      throw new Error("Expected materialization");
    }
    const task = materialization.tasks[0];
    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
      ...meta,
      status: "pr-open",
      prUrl: "https://example.com/pr/1"
    });
    recordStage(repoPaths, task.taskId, "check", {
      status: "passed"
    });
    recordStage(repoPaths, task.taskId, "review", {
      status: "passed"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "ci",
        status: "pending",
        next: "devtask work ci WORK-123"
      })
    ]);
  });

  it("falls back to the repo-local remediation path when CI fails", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-board-ci-failed-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Implement work"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
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
    await approveWorkPlan(paths, item);
    markMaterializedTasksPlanned(paths, item.id);
    const materialization = readWorkMaterialization(paths, item.id);
    if (!materialization) {
      throw new Error("Expected materialization");
    }
    const task = materialization.tasks[0];
    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
      ...meta,
      status: "ci-failed",
      prUrl: "https://example.com/pr/1"
    });
    recordStage(repoPaths, task.taskId, "check", {
      status: "passed",
      startedAt: "2027-05-05T00:00:00.000Z",
      finishedAt: "2027-05-05T00:00:01.000Z"
    });
    recordStage(repoPaths, task.taskId, "review", {
      status: "passed",
      startedAt: "2027-05-05T00:00:02.000Z",
      finishedAt: "2027-05-05T00:00:03.000Z"
    });
    recordStage(repoPaths, task.taskId, "ci", {
      status: "failed",
      startedAt: "2027-05-05T00:00:04.000Z",
      finishedAt: "2027-05-05T00:00:05.000Z",
      reason: "CI check failed"
    });

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "ci",
        status: "failed",
        next: expect.stringContaining("devtask task continue work-123-backend")
      })
    ]);
  });
});

function markMaterializedTasksPlanned(paths: ReturnType<typeof resolveWorkspacePathsForInit>, workId: string): void {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new Error("Expected materialization");
  }
  for (const task of materialization.tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    const planPath = planMarkdownPath(repoPaths, task.taskId);
    fs.writeFileSync(planPath, "# Plan\n");
    writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
      ...meta,
      status: "planned",
      updatedAt: new Date().toISOString()
    });
    recordStage(repoPaths, task.taskId, "plan", {
      status: "passed",
      output: { planPath },
      artifacts: [planPath]
    });
  }
}
