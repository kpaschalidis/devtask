import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTask, planTaskCleanup } from "../src/cleanup.js";
import { DevtaskError } from "../src/infra/errors.js";
import { resolvePaths } from "../src/infra/paths.js";
import { createTask } from "../src/storage/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("cleanup", () => {
  it("plans task metadata and worktree removal", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "cleanup-task");

    const plan = await planTaskCleanup(paths, meta.id);

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContain(`remove worktree ${meta.worktreePath}`);
    expect(plan.actions).toContain(`remove metadata ${path.join(paths.tasksDir, meta.id)}`);
  });

  it("refuses to cleanup dirty worktrees by default", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "dirty-task");
    fs.writeFileSync(path.join(meta.worktreePath, "dirty.txt"), "dirty\n");

    await expect(cleanupTask(paths, meta.id)).rejects.toThrow(DevtaskError);
  });

  it("removes clean task worktrees and metadata", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "remove-task");

    await cleanupTask(paths, meta.id);

    expect(fs.existsSync(meta.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(paths.tasksDir, meta.id))).toBe(false);
  });
});
