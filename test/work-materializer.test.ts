import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  taskMetaPath,
  workItemApprovedGraphPath,
  workItemMaterializationPath
} from "../src/paths.js";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { createManualWorkItem } from "../src/work-store.js";
import { approveWorkPlan, readWorkGraph } from "../src/work-materializer.js";
import { workGraphPath } from "../src/work-planner.js";
import { readTaskMeta } from "../src/meta.js";
import { makeTempRepo } from "./helpers.js";

describe("work materializer", () => {
  it("approves a graph and creates repo-local task worktrees", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior",
      body: "Implement the backend part."
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
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

    const materialization = await approveWorkPlan(paths, item);

    expect(materialization.tasks).toHaveLength(1);
    expect(materialization.tasks[0]).toMatchObject({
      graphTaskId: "work-123-backend",
      target: "backend",
      taskId: "work-123-backend",
      branch: "task/work-123-backend"
    });
    expect(fs.existsSync(workItemApprovedGraphPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(workItemMaterializationPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".devtask", "tasks", "work-123-backend", "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".devtask", "worktrees", "work-123-backend"))).toBe(true);
    const meta = readTaskMeta(taskMetaPath(resolveWorkspacePathsForInit(repo), "work-123-backend"));

    expect(meta.command).toContain(`--add-dir ${path.join(paths.workDir, item.id)}`);
    expect(meta.command).toContain(`--add-dir ${path.dirname(item.source.artifact)}`);
  });

  it("rejects unknown dependency references", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-deps-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
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
              dependsOn: ["missing"]
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    expect(() => readWorkGraph(paths, item.id)).toThrow("depends on unknown task missing");
  });

  it("rejects unknown target ids during approval", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-target-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
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

    await expect(approveWorkPlan(paths, item)).rejects.toThrow("Workspace target backend does not exist");
  });

  it("rejects approval when the human-readable plan artifact is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-plan-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
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
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await expect(approveWorkPlan(paths, item)).rejects.toThrow("Run devtask work plan WORK-123 first");
  });

  it("reports existing materialization before repo task preflight errors", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-existing-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
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

    await expect(approveWorkPlan(paths, item)).rejects.toThrow("has already been materialized");
  });
});
