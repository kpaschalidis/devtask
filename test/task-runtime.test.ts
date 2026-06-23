import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/infra/processes.js", () => ({
  isProcessAlive: vi.fn(() => false)
}));

vi.mock("../src/adapters/agent-kernel/tmux-control.js", () => ({
  tmuxSessionExists: vi.fn(() => false)
}));

import { reconcileTaskRuntime } from "../src/task-runtime.js";
import { resolvePaths, taskMetaPath } from "../src/infra/paths.js";
import { createTask } from "../src/storage/task-store.js";
import { readTaskMeta, writeTaskMeta } from "../src/storage/meta.js";
import { makeTempRepo } from "./helpers.js";

describe("task runtime reconciliation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks lost execution sessions as paused instead of failed", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "runtime-task");
    const metaPath = taskMetaPath(paths, meta.id);

    writeTaskMeta(metaPath, {
      ...meta,
      status: "running",
      tmuxSession: "devtask-runtime-task",
      updatedAt: new Date().toISOString()
    });

    const reconciled = reconcileTaskRuntime(paths, readTaskMeta(metaPath));

    expect(reconciled.status).toBe("paused");
    expect(reconciled.resultSummary).toContain("is not running");
    expect(fs.existsSync(path.join(repo, ".devtask", "tasks", meta.id, "meta.json"))).toBe(true);
  });
});
