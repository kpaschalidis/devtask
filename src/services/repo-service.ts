import type { DevtaskPaths } from "../paths.js";
import {
  addWorkspaceTarget,
  getWorkspaceTarget,
  listWorkspaceTargets,
  removeWorkspaceTarget,
  type WorkspaceTarget
} from "../workspace-targets.js";

export type RepoRecord = WorkspaceTarget;

export function listRepos(paths: DevtaskPaths): RepoRecord[] {
  return listWorkspaceTargets(paths);
}

export function getRepo(paths: DevtaskPaths, repoId: string): RepoRecord {
  return getWorkspaceTarget(paths, repoId);
}

export function addRepo(
  paths: DevtaskPaths,
  options: { id: string; path: string; kind?: string | null; scope?: string | null }
): RepoRecord {
  return addWorkspaceTarget(paths, {
    id: options.id,
    repoPath: options.path,
    kind: options.kind,
    scope: options.scope
  });
}

export function removeRepo(paths: DevtaskPaths, repoId: string): RepoRecord {
  return removeWorkspaceTarget(paths, repoId);
}
