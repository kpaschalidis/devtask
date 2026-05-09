import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceTarget,
  getWorkspaceTarget,
  listWorkspaceTargets,
  removeWorkspaceTarget
} from "../src/workspace-targets.js";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("workspace targets", () => {
  it("stores repo targets in workspace metadata", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-targets-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    const target = addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });

    expect(target).toMatchObject({
      id: "backend",
      repoPath: repo,
      scope: null,
      kind: "api"
    });
    expect(listWorkspaceTargets(paths).map((item) => item.id)).toEqual(["backend"]);
    expect(getWorkspaceTarget(paths, "backend").repoPath).toBe(repo);
  });

  it("stores repo scope targets", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-target-scopes-"));
    const repo = await makeTempRepo({ withCommit: true });
    const scope = path.join(repo, "packages", "api");
    fs.mkdirSync(scope, { recursive: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    const target = addWorkspaceTarget(paths, {
      id: "api",
      repoPath: repo,
      scope: "packages/api"
    });

    expect(target.scope).toBe(path.join("packages", "api"));
  });

  it("removes targets", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-target-remove-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    addWorkspaceTarget(paths, {
      id: "web",
      repoPath: repo
    });

    expect(removeWorkspaceTarget(paths, "web").id).toBe("web");

    expect(listWorkspaceTargets(paths)).toEqual([]);
  });

  it("rejects duplicate repo scopes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-target-duplicates-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo
    });

    expect(() =>
      addWorkspaceTarget(paths, {
        id: "api",
        repoPath: repo
      })
    ).toThrow("already uses repo/scope");
  });

  it("rejects scopes outside the target repo", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-target-invalid-scope-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    expect(() =>
      addWorkspaceTarget(paths, {
        id: "api",
        repoPath: repo,
        scope: "../other"
      })
    ).toThrow("must not contain parent directory segments");
  });
});
