import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths, resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { resolveTaskCommandTarget } from "../src/task-command-target.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("task command target", () => {
  it("resolves plain ids against the current repo", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const resolved = resolveTaskCommandTarget("task-123", repo);

    expect(resolved.taskId).toBe("task-123");
    expect(resolved.displayId).toBe("task-123");
    expect(fs.realpathSync(resolved.paths.root)).toBe(fs.realpathSync(resolvePaths(repo).root));
  });

  it("resolves target/task ids against the workspace target repo", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-task-target-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });

    const resolved = resolveTaskCommandTarget("backend/task-123", workspace);

    expect(resolved.taskId).toBe("task-123");
    expect(resolved.displayId).toBe("backend/task-123");
    expect(fs.realpathSync(resolved.paths.root)).toBe(fs.realpathSync(resolvePaths(repo).root));
  });
});
