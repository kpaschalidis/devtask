import type { DevtaskPaths } from "../paths.js";
import {
  addWorkspaceRepo,
  getWorkspaceRepo,
  listWorkspaceRepos,
  removeWorkspaceRepo,
  type WorkspaceRepo
} from "../workspace-repos.js";

export type RepoRecord = WorkspaceRepo;

export function listRepos(paths: DevtaskPaths): RepoRecord[] {
  return listWorkspaceRepos(paths);
}

export function getRepo(paths: DevtaskPaths, repoId: string): RepoRecord {
  return getWorkspaceRepo(paths, repoId);
}

export function addRepo(
  paths: DevtaskPaths,
  options: { id: string; path: string; kind?: string | null; scope?: string | null }
): RepoRecord {
  return addWorkspaceRepo(paths, {
    id: options.id,
    repoPath: options.path,
    kind: options.kind,
    scope: options.scope
  });
}

export function removeRepo(paths: DevtaskPaths, repoId: string): RepoRecord {
  return removeWorkspaceRepo(paths, repoId);
}
