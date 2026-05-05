import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTaskMeta } from "../src/meta.js";
import { resolvePaths, taskMetaPath } from "../src/paths.js";
import { writeRunRecord } from "../src/run-record.js";
import { buildTaskReview, inspectTaskHealth, readLatestLogPath } from "../src/task-inspection.js";
import { createTask } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("task inspection", () => {
  it("builds a review with changed files, latest run, and result", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-task");
    const logPath = path.join(repo, ".devtask", "tasks", meta.id, "logs", "run.log");
    fs.writeFileSync(logPath, "hello\n");
    fs.writeFileSync(meta.resultPath, "{\n  \"status\": \"done\"\n}\n");
    fs.writeFileSync(path.join(meta.worktreePath, "changed.txt"), "changed\n");

    writeRunRecord(path.join(repo, ".devtask", "tasks", meta.id, "runs"), {
      schemaVersion: 1,
      runId: "2026-01-01T00-00-00-000Z",
      taskId: meta.id,
      status: "success",
      command: meta.command,
      cwd: meta.worktreePath,
      logPath,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0
    });

    const review = await buildTaskReview(paths, meta);

    expect(readLatestLogPath(paths, meta.id)).toBe(logPath);
    expect(review.latestRun?.status).toBe("success");
    expect(review.result).toEqual({ status: "done" });
    expect(review.changedFiles).toContain("?? changed.txt");
  });

  it("reports stale running supervisors", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "stale-task");
    const stale = {
      ...meta,
      status: "running" as const,
      supervisorPid: 99999999,
      updatedAt: new Date().toISOString()
    };
    writeTaskMeta(taskMetaPath(paths, meta.id), stale);

    expect(inspectTaskHealth(stale)).toEqual([
      {
        taskId: meta.id,
        message: "status is running but supervisor process is not alive"
      }
    ]);
  });
});
