import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTaskMeta, writeTaskMeta } from "../src/meta.js";
import { planMarkdownPath, resolveWorkspacePathsForInit, taskMetaPath } from "../src/paths.js";
import { readStageLedger } from "../src/stage-contracts.js";
import { initializeWorkspace } from "../src/task-store.js";
import { approveWorkPlan } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import { createWorkRepoPlans } from "../src/work-repo-planner.js";
import { createManualWorkItem } from "../src/work-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("work repo planner", () => {
  it("creates repo-local plans from the approved graph and marks tasks planned", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-repo-plan-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add backend behavior",
      body: "Implement the backend behavior."
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Work Plan\n\nCoordinate backend behavior.\n");
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
    const repoPaths = resolveWorkspacePathsForInit(fs.realpathSync(repo));

    const results = createWorkRepoPlans(paths, item);

    expect(results).toEqual([
      expect.objectContaining({
        target: "backend",
        taskId: "work-123-backend",
        planPath: planMarkdownPath(repoPaths, "work-123-backend"),
        status: "planned"
      })
    ]);
    const plan = fs.readFileSync(planMarkdownPath(repoPaths, "work-123-backend"), "utf8");
    expect(plan).toContain("# Repo Plan: work-123-backend");
    expect(plan).toContain("Implement backend behavior.");
    expect(plan).toContain("- server/**");
    expect(plan).toContain("Coordinate backend behavior.");
    expect(readTaskMeta(taskMetaPath(repoPaths, "work-123-backend")).status).toBe("planned");
    expect(readStageLedger(repoPaths, "work-123-backend").stages.plan).toMatchObject({
      status: "passed",
      output: {
        planPath: planMarkdownPath(repoPaths, "work-123-backend")
      }
    });
  });

  it("requires approved materialization before repo planning", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-repo-plan-missing-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add backend behavior"
    });

    expect(() => createWorkRepoPlans(paths, item)).toThrow("Run devtask work approve-plan WORK-123 first");
  });

  it("refuses to reset a task after it has moved past planning", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-repo-plan-review-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add backend behavior"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Work Plan\n\nCoordinate backend behavior.\n");
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
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );
    await approveWorkPlan(paths, item);
    const repoPaths = resolveWorkspacePathsForInit(fs.realpathSync(repo));
    const meta = readTaskMeta(taskMetaPath(repoPaths, "work-123-backend"));
    writeTaskMeta(taskMetaPath(repoPaths, "work-123-backend"), {
      ...meta,
      status: "review"
    });

    expect(() => createWorkRepoPlans(paths, item)).toThrow("repo planning is only available before the task runs");
  });
});
