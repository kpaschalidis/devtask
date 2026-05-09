import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { buildWorkBoardRows } from "../src/work-board.js";
import { approveWorkPlan } from "../src/work-materializer.js";
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
        stage: "plan",
        status: "pending",
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

  it("shows materialized repo-local task state with repo-scoped next commands", async () => {
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
              dependsOn: []
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
    const repoPath = fs.realpathSync(repo);

    await expect(buildWorkBoardRows(paths, item)).resolves.toEqual([
      expect.objectContaining({
        target: "backend",
        task: "work-123-backend",
        stage: "plan",
        status: "pending",
        next: `(cd ${repoPath} && devtask plan work-123-backend)`
      })
    ]);
  });
});
