import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { buildWorkBoardRows } from "../src/work-board.js";
import { approveWorkPlan } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import { createWorkRepoPlans } from "../src/work-repo-planner.js";
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
        stage: "plan",
        status: "pending",
        last: "-",
        blocked: "-",
        next: "devtask work plan WORK-123"
      })
    ]);
  });

  it("shows the approve-plan next step after a graph exists", async () => {
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
        stage: "approve-plan",
        status: "pending",
        next: "devtask work approve-plan WORK-123"
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
        stage: "plan",
        next: "devtask work plan WORK-123"
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
        stage: "plan",
        status: "pending",
        blocked: "needs repo-plan",
        next: "needs repo-plan"
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
    createWorkRepoPlans(paths, item);

    const rows = await buildWorkBoardRows(paths, item);

    expect(rows).toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "run",
        status: "ready",
        last: "plan passed",
        blocked: "-",
        next: "devtask work run WORK-123"
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
});
