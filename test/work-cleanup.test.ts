import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { taskDir, workItemDir, workItemMaterializationPath, resolvePaths, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { createTask } from "../src/storage/task-store.js";
import { cleanupWorkItem } from "../src/work-cleanup.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("work cleanup", () => {
  it("preserves work history while removing materialized repo task state", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-cleanup-"));
    const repo = await makeTempRepo({ withCommit: true });
    const workspacePaths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(workspacePaths);
    const item = createManualWorkItem(workspacePaths, {
      id: "cleanup-work",
      title: "Cleanup work"
    });

    const repoPaths = resolvePaths(repo);
    const task = await createTask(repoPaths, "cleanup-task");
    fs.writeFileSync(
      workItemMaterializationPath(workspacePaths, item.id),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          graphSnapshotPath: path.join(workItemDir(workspacePaths, item.id), "graph.snapshot.json"),
          materializedAt: new Date().toISOString(),
          tasks: [
            {
              graphTaskId: "cleanup-task",
              repoId: "app",
              repoPath: repo,
              scope: null,
              taskId: task.id,
              branch: task.branch,
              worktreePath: task.worktreePath
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const dryRun = await cleanupWorkItem(workspacePaths, item, { dryRun: true });
    expect(dryRun.blockers).toEqual([]);
    expect(fs.existsSync(workItemDir(workspacePaths, item.id))).toBe(true);
    expect(fs.existsSync(taskDir(repoPaths, task.id))).toBe(true);
    expect(fs.existsSync(task.worktreePath)).toBe(true);

    await cleanupWorkItem(workspacePaths, item);
    expect(fs.existsSync(workItemDir(workspacePaths, item.id))).toBe(true);
    expect(fs.existsSync(taskDir(repoPaths, task.id))).toBe(true);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
  });
});
