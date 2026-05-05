import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/errors.js";
import { resolvePaths } from "../src/paths.js";
import { createTask, getTask, initializeStore, listTasks } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("task store", () => {
  it("initializes storage directories", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);

    initializeStore(paths);

    expect(fs.existsSync(paths.tasksDir)).toBe(true);
    expect(fs.existsSync(paths.worktreesDir)).toBe(true);
  });

  it("creates a task with durable files and an isolated worktree", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);

    const meta = await createTask(paths, "fix-login", {
      goal: "Fix login redirect loop"
    });

    expect(meta).toMatchObject({
      schemaVersion: 1,
      id: "fix-login",
      status: "created",
      branch: "task/fix-login",
      supervisorPid: null,
      childPid: null,
      failCount: 0,
      maxRetries: 5
    });
    expect(fs.existsSync(meta.taskPath)).toBe(true);
    expect(fs.existsSync(meta.statePath)).toBe(true);
    expect(fs.existsSync(meta.resultPath)).toBe(true);
    expect(fs.existsSync(meta.worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(meta.worktreePath, ".git"))).toBe(true);
    expect(fs.readFileSync(meta.taskPath, "utf8")).toContain("Fix login redirect loop");
  });

  it("lists task summaries in stable id order", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);

    await createTask(paths, "z-task");
    await createTask(paths, "a-task");

    expect(listTasks(paths).map((task) => task.id)).toEqual(["a-task", "z-task"]);
  });

  it("reads an existing task by id", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);

    await createTask(paths, "docs");

    expect(getTask(paths, "docs").id).toBe("docs");
  });

  it("rejects unsafe task ids", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);

    await expect(createTask(paths, "../escape")).rejects.toThrow(DevtaskError);
  });

  it("refuses to create a worktree before the repository has an initial commit", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);

    await expect(createTask(paths, "first-task")).rejects.toThrow(
      "Cannot create task worktrees before the repository has an initial commit."
    );
  });
});
