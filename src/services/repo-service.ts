import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { findRepoRoot, resolveWorkspacePaths } from "../infra/paths.js";
import {
  addWorkspaceRepo,
  bindWorkspaceRepo,
  getWorkspaceRepo,
  listRepoBindingStatuses,
  listWorkspaceRepos,
  removeWorkspaceRepo,
  type RepoBindingStatus,
  type WorkspaceRepo
} from "../storage/workspace-repos.js";
import { getWorkspaceById } from "./workspace-service.js";

export type RepoRecord = WorkspaceRepo;

export interface RepoDoctorIssue {
  repoId: string;
  severity: "warning";
  message: string;
}

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

export function bindRepo(
  workspaceId: string,
  repoId: string,
  options: { path?: string; here?: boolean }
): RepoRecord {
  const workspace = getWorkspaceById(workspaceId);
  const paths = resolveWorkspacePaths(workspace.path);
  const repoPath = options.here ? findRepoRoot(process.cwd()) : path.resolve(options.path ?? "");
  if (!repoPath) {
    throw new Error("Repo path is required");
  }
  return bindWorkspaceRepo(paths, repoId, repoPath);
}

export function listRepoBindings(workspaceId: string): RepoBindingStatus[] {
  const workspace = getWorkspaceById(workspaceId);
  return listRepoBindingStatuses(resolveWorkspacePaths(workspace.path));
}

export function diagnoseRepoBindings(workspaceId: string): RepoDoctorIssue[] {
  const statuses = listRepoBindings(workspaceId);
  const issues: RepoDoctorIssue[] = [];
  for (const repo of statuses) {
    if (!repo.bound || !repo.repoPath) {
      issues.push({
        repoId: repo.id,
        severity: "warning",
        message: "missing local repo binding"
      });
      continue;
    }
    if (!fs.existsSync(repo.repoPath)) {
      issues.push({
        repoId: repo.id,
        severity: "warning",
        message: `local path does not exist: ${repo.repoPath}`
      });
      continue;
    }
    if (!fs.existsSync(path.join(repo.repoPath, ".git"))) {
      issues.push({
        repoId: repo.id,
        severity: "warning",
        message: `local path is not a git repository: ${repo.repoPath}`
      });
      continue;
    }
    if (repo.scope && !fs.existsSync(path.join(repo.repoPath, repo.scope))) {
      issues.push({
        repoId: repo.id,
        severity: "warning",
        message: `repo scope does not exist: ${path.join(repo.repoPath, repo.scope)}`
      });
    }
  }
  return issues;
}
