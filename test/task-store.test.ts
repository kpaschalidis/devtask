import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/infra/errors.js";
import { resolvePaths } from "../src/infra/paths.js";
import { createTask, getTask, initializeStore, listTasks } from "../src/storage/task-store.js";
import { makeTempRepo } from "./helpers.js";
import { readConfig } from "../src/infra/config.js";
import { runCommandOrThrow } from "../src/infra/process-runner.js";

describe("task store", () => {
  it("initializes storage directories", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);

    initializeStore(paths);

    expect(fs.existsSync(paths.tasksDir)).toBe(true);
    expect(fs.existsSync(paths.worktreesDir)).toBe(true);
    expect(readConfig(paths)).toEqual({
      schemaVersion: 1,
      tracker: {
        provider: null
      },
      scm: {
        provider: null
      },
      agent: {
        provider: "codex"
      },
      agentSessions: {
        roots: {
          codex: null,
          cursor: null
        }
      },
      codex: {
        model: null,
        fullAuto: true
      },
      runtime: {
        mode: "attachable",
        backend: "tmux"
      },
      runtimeConfigured: false,
      jira: {
        baseUrl: null,
        email: null,
        cloudId: null
      },
      verify: []
    });
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
      model: null,
      command: "",
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

    fs.writeFileSync(path.join(meta.worktreePath, ".devtask_state.md"), "state\n");
    fs.writeFileSync(path.join(meta.worktreePath, ".devtask_result.json"), "{}\n");
    const status = await runCommandOrThrow("git", ["status", "--short"], { cwd: meta.worktreePath });
    expect(status.stdout).not.toContain(".devtask_state.md");
    expect(status.stdout).not.toContain(".devtask_result.json");
  });

  it("stores caller-supplied model and command", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);

    const meta = await createTask(paths, "model-task", {
      model: "gpt-5.2",
      command: 'codex exec --full-auto -m gpt-5.2 - < "$DEVTASK_TASK_PATH"'
    });

    expect(meta.model).toBe("gpt-5.2");
    expect(meta.command).toBe('codex exec --full-auto -m gpt-5.2 - < "$DEVTASK_TASK_PATH"');
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
