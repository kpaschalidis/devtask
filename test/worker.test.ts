import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTaskMeta, writeTaskMeta } from "../src/meta.js";
import { resolvePaths, taskMetaPath } from "../src/paths.js";
import { createTask } from "../src/task-store.js";
import { runWorker } from "../src/worker.js";
import { makeTempRepo } from "./helpers.js";

describe("worker", () => {
  it("runs a task command, writes a run record, and stops when result is done", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "complete-task", {
      command:
        "node -e \"require('fs').writeFileSync(process.env.DEVTASK_RESULT_PATH, JSON.stringify({status:'done'}, null, 2))\""
    });

    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    await runWorker(meta.id, { root: repo, intervalMs: 10 });

    const updated = readTaskMeta(taskMetaPath(paths, meta.id));
    const runs = fs.readdirSync(path.join(repo, ".devtask", "tasks", meta.id, "runs"));
    const logs = fs.readdirSync(path.join(repo, ".devtask", "tasks", meta.id, "logs"));

    expect(updated.status).toBe("done");
    expect(updated.failCount).toBe(0);
    expect(updated.supervisorPid).toBeNull();
    expect(updated.childPid).toBeNull();
    expect(runs).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("harvests worktree-local task state and result after a run", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "runtime-files-task", {
      command:
        "node -e \"const fs=require('fs'); fs.appendFileSync(process.env.DEVTASK_STATE_PATH, '\\n- updated in worktree\\n'); fs.writeFileSync(process.env.DEVTASK_RESULT_PATH, JSON.stringify({status:'done'}, null, 2))\""
    });

    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    await runWorker(meta.id, { root: repo, intervalMs: 10 });

    const updated = readTaskMeta(taskMetaPath(paths, meta.id));
    expect(updated.status).toBe("done");
    expect(fs.readFileSync(meta.statePath, "utf8")).toContain("- updated in worktree");
    expect(JSON.parse(fs.readFileSync(meta.resultPath, "utf8"))).toEqual({ status: "done" });
    expect(fs.existsSync(path.join(meta.worktreePath, ".devtask_state.md"))).toBe(true);
    expect(fs.existsSync(path.join(meta.worktreePath, ".devtask_result.json"))).toBe(true);
  });

  it("marks a task failed after max retries", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "failing-task", {
      command: "node -e \"process.exit(9)\"",
      maxRetries: 1
    });

    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    await runWorker(meta.id, { root: repo, intervalMs: 10 });

    const updated = readTaskMeta(taskMetaPath(paths, meta.id));
    expect(updated.status).toBe("failed");
    expect(updated.failCount).toBe(1);
    expect(updated.supervisorPid).toBeNull();
  });

  it("stops for review when a successful command does not write a terminal result", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-task", {
      command: "node -e \"process.exit(0)\""
    });

    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    await runWorker(meta.id, { root: repo, intervalMs: 10 });

    const updated = readTaskMeta(taskMetaPath(paths, meta.id));
    expect(updated.status).toBe("review");
    expect(updated.failCount).toBe(0);
    expect(updated.supervisorPid).toBeNull();
  });

  it("marks a task blocked when result.json reports blocked", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "blocked-task", {
      command:
        "node -e \"require('fs').writeFileSync(process.env.DEVTASK_RESULT_PATH, JSON.stringify({status:'blocked', reason:'missing input'}, null, 2))\""
    });

    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    await runWorker(meta.id, { root: repo, intervalMs: 10 });

    const updated = readTaskMeta(taskMetaPath(paths, meta.id));
    expect(updated.status).toBe("blocked");
    expect(updated.failCount).toBe(0);
    expect(updated.supervisorPid).toBeNull();
  });
});
