import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalIndexPath, readGlobalIndex, registerWorkspace, updateRecentWork } from "../src/global-index.js";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { createManualWorkItem } from "../src/work-store.js";

describe("global index", () => {
  const originalHome = process.env.DEVTASK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.DEVTASK_HOME;
    } else {
      process.env.DEVTASK_HOME = originalHome;
    }
  });

  it("registers workspaces in disposable global state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-index-workspace-"));
    process.env.DEVTASK_HOME = home;
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    const entry = registerWorkspace(paths);

    expect(entry.path).toBe(fs.realpathSync(workspace));
    expect(fs.existsSync(globalIndexPath())).toBe(true);
    expect(readGlobalIndex().workspaces.map((item) => item.path)).toEqual([fs.realpathSync(workspace)]);
  });

  it("indexes recent work as pointers to workspace artifacts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-index-work-"));
    process.env.DEVTASK_HOME = home;
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "APP-123",
      title: "Add billing export"
    });

    const recent = await updateRecentWork(paths, item);

    expect(recent).toMatchObject({
      workId: "APP-123",
      title: "Add billing export",
      status: "created",
      workspacePath: fs.realpathSync(workspace)
    });
    expect(readGlobalIndex().recentWork.map((work) => work.workId)).toEqual(["APP-123"]);
  });
});
