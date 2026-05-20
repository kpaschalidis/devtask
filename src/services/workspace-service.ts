import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { resolveWorkspacePaths, resolveWorkspacePathsForInit } from "../infra/paths.js";
import {
  findIndexedWork,
  readGlobalIndex,
  refreshWorkspaceRecentWork,
  registerWorkspace,
  removeWorkspaceFromIndex,
  type GlobalRecentWorkEntry,
  type GlobalWorkspaceEntry
} from "../storage/global-index.js";
import { initializeStore, initializeWorkspace } from "../storage/task-store.js";
import { addWorkspaceRepo, listWorkspaceRepos } from "../storage/workspace-repos.js";

export interface InitWorkspaceOptions {
  register?: boolean;
}

export function initializeCurrentWorkspace(start = process.cwd(), options: InitWorkspaceOptions = {}): {
  paths: DevtaskPaths;
  registered: GlobalWorkspaceEntry | null;
} {
  const paths = resolveWorkspacePathsForInit(start);
  initializeWorkspace(paths);
  if (fs.existsSync(path.join(paths.root, ".git"))) {
    initializeStore(paths);
    if (listWorkspaceRepos(paths).length === 0) {
      addWorkspaceRepo(paths, { id: "app", repoPath: ".", kind: "repo" });
    }
  }

  return {
    paths,
    registered: options.register === false ? null : registerWorkspace(paths)
  };
}

export function listRegisteredWorkspaces(): GlobalWorkspaceEntry[] {
  return readGlobalIndex().workspaces;
}

export function registerWorkspacePath(workspacePath?: string): GlobalWorkspaceEntry {
  const paths = workspacePath ? resolveWorkspacePaths(workspacePath) : resolveWorkspacePaths();
  return registerWorkspace(paths);
}

export function removeRegisteredWorkspace(idOrPath: string): GlobalWorkspaceEntry {
  return removeWorkspaceFromIndex(idOrPath);
}

export async function listRecentWorkspaceWork(currentWorkspacePath?: string): Promise<GlobalRecentWorkEntry[]> {
  if (currentWorkspacePath) {
    await refreshWorkspaceRecentWork(resolveWorkspacePaths(currentWorkspacePath));
  } else {
    try {
      await refreshWorkspaceRecentWork(resolveWorkspacePaths());
    } catch {
      // Allow listing global recent work even when outside a workspace.
    }
  }
  return readGlobalIndex().recentWork;
}

export async function locateWork(workId: string): Promise<GlobalRecentWorkEntry | null> {
  return findIndexedWork(workId);
}
