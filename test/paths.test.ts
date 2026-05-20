import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/infra/errors.js";
import { findRepoRoot, resolvePaths, resolveWorkspacePaths, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("paths", () => {
  it("finds the git root from a nested directory", async () => {
    const repo = await makeTempRepo();
    const nested = path.join(repo, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(repo);
  });

  it("throws when no git repository can be found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-no-git-"));

    try {
      expect(() => findRepoRoot(dir)).toThrow(DevtaskError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the devtask storage layout from the repo root", async () => {
    const repo = await makeTempRepo();

    expect(resolvePaths(repo)).toEqual({
      root: repo,
      baseDir: path.join(repo, ".devtask"),
      markerDir: path.join(repo, ".devtask"),
      sharedDir: path.join(repo, ".devtask"),
      localDir: path.join(repo, ".devtask"),
      workspaceId: null,
      configPath: path.join(repo, ".devtask", "config.json"),
      tasksDir: path.join(repo, ".devtask", "tasks"),
      worktreesDir: path.join(repo, ".devtask", "worktrees"),
      workDir: path.join(repo, ".devtask", "work")
    });
  });

  it("resolves a non-git workspace from a nested directory", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const nested = path.join(workspace, "products", "studio");
    const previousHome = process.env.DEVTASK_HOME;

    try {
      process.env.DEVTASK_HOME = home;
      fs.mkdirSync(nested, { recursive: true });
      const initialized = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(initialized);

      expect(resolveWorkspacePaths(nested)).toEqual({
        root: workspace,
        baseDir: path.join(home, "workspaces", initialized.workspaceId!),
        markerDir: path.join(workspace, ".devtask"),
        sharedDir: path.join(home, "workspaces", initialized.workspaceId!, "shared"),
        localDir: path.join(home, "workspaces", initialized.workspaceId!, "local"),
        workspaceId: initialized.workspaceId,
        configPath: path.join(home, "workspaces", initialized.workspaceId!, "shared", "config.json"),
        tasksDir: path.join(home, "workspaces", initialized.workspaceId!, "local", "tasks"),
        worktreesDir: path.join(home, "workspaces", initialized.workspaceId!, "local", "worktrees"),
        workDir: path.join(home, "workspaces", initialized.workspaceId!, "shared", "work")
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.DEVTASK_HOME;
      } else {
        process.env.DEVTASK_HOME = previousHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("explains how to initialize devtask outside git", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-no-workspace-"));

    try {
      expect(() => resolveWorkspacePaths(dir)).toThrow("Run devtask init");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
