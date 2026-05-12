import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTaskMeta } from "../src/meta.js";
import { resolvePaths, taskMetaPath } from "../src/paths.js";
import { getTask, initializeStore } from "../src/task-store.js";
import { recordStage, readStageLedger } from "../src/stage-contracts.js";
import { createTask } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("task runtime reconciliation", () => {
  it("demotes stale running tmux tasks to failed", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    await createTask(paths, "task-123", { goal: "Test stale runtime" });

    const metaPath = taskMetaPath(paths, "task-123");
    const meta = getTask(paths, "task-123");
    writeTaskMeta(metaPath, {
      ...meta,
      status: "running",
      supervisorPid: null,
      childPid: null,
      tmuxSession: "devtask-missing-session",
      updatedAt: new Date().toISOString()
    });
    recordStage(paths, "task-123", "run", {
      status: "running",
      input: {
        mode: "attachable",
        tmuxSession: "devtask-missing-session"
      }
    });

    const reconciled = getTask(paths, "task-123");
    const runStage = readStageLedger(paths, "task-123").stages.run;

    expect(reconciled.status).toBe("failed");
    expect(reconciled.tmuxSession).toBeNull();
    expect(runStage?.status).toBe("failed");
    expect(runStage?.reason).toContain("recorded tmux session devtask-missing-session is not running");
  });
});
