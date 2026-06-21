import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  workItemRepoContextPath,
  workItemLearningsPath
} from "../src/infra/paths.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

describe("context and learning paths", () => {
  function makeWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-ctx-paths-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    return paths;
  }

  it("workItemRepoContextPath is adjacent to the repo-plan", () => {
    const paths = makeWorkspace();
    const planPath = path.join(paths.workDir, "work-1", "repo-plans", "backend.md");
    const contextPath = workItemRepoContextPath(paths, "work-1", "backend");
    expect(path.dirname(contextPath)).toBe(path.dirname(planPath));
    expect(contextPath).toBe(path.join(paths.workDir, "work-1", "repo-plans", "backend.context.md"));
  });

  it("workItemLearningsPath is under the shared work item dir", () => {
    const paths = makeWorkspace();
    expect(workItemLearningsPath(paths, "work-1")).toBe(
      path.join(paths.workDir, "work-1", "learnings.md")
    );
  });
});
