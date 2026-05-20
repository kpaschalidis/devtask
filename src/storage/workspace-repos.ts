import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { resolvePaths, workspaceReposPath } from "../infra/paths.js";

export interface WorkspaceRepo {
  id: string;
  repoPath: string;
  scope: string | null;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceReposFile {
  schemaVersion: 1;
  repos: WorkspaceRepo[];
}

export interface AddWorkspaceRepoOptions {
  id: string;
  repoPath: string;
  scope?: string | null;
  kind?: string | null;
}

export function listWorkspaceRepos(paths: DevtaskPaths): WorkspaceRepo[] {
  return [...readReposFile(paths).repos].sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkspaceRepo(paths: DevtaskPaths, id: string): WorkspaceRepo {
  const repo = listWorkspaceRepos(paths).find((item) => item.id === id);
  if (!repo) {
    throw new DevtaskError(`Workspace repo ${id} does not exist`);
  }
  return repo;
}

export function addWorkspaceRepo(paths: DevtaskPaths, options: AddWorkspaceRepoOptions): WorkspaceRepo {
  assertValidRepoId(options.id);
  const repoPaths = resolvePaths(resolveWorkspaceRelativePath(paths, options.repoPath));
  const repoPath = fs.realpathSync(repoPaths.root);
  const scope = normalizeScope(options.scope);
  const kind = normalizeOptionalString(options.kind);
  const scopePath = scope ? path.join(repoPath, scope) : repoPath;
  if (!fs.existsSync(scopePath)) {
    throw new DevtaskError(`Workspace repo scope does not exist: ${scopePath}`);
  }

  const file = readReposFile(paths);
  if (file.repos.some((repo) => repo.id === options.id)) {
    throw new DevtaskError(`Workspace repo ${options.id} already exists`);
  }

  const duplicate = file.repos.find((repo) => repo.repoPath === repoPath && repo.scope === scope);
  if (duplicate) {
    throw new DevtaskError(`Workspace repo ${duplicate.id} already uses repo/scope ${formatRepoScope(repoPath, scope)}`);
  }

  const now = new Date().toISOString();
  const repo: WorkspaceRepo = {
    id: options.id,
    repoPath,
    scope,
    kind,
    createdAt: now,
    updatedAt: now
  };
  writeReposFile(paths, {
    schemaVersion: 1,
    repos: [...file.repos, repo]
  });
  return repo;
}

export function removeWorkspaceRepo(paths: DevtaskPaths, id: string): WorkspaceRepo {
  const file = readReposFile(paths);
  const repo = file.repos.find((item) => item.id === id);
  if (!repo) {
    throw new DevtaskError(`Workspace repo ${id} does not exist`);
  }
  writeReposFile(paths, {
    schemaVersion: 1,
    repos: file.repos.filter((item) => item.id !== id)
  });
  return repo;
}

function readReposFile(paths: DevtaskPaths): WorkspaceReposFile {
  const filePath = workspaceReposPath(paths);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      repos: []
    };
  }

  return parseReposFile(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function writeReposFile(paths: DevtaskPaths, file: WorkspaceReposFile): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(workspaceReposPath(paths), `${JSON.stringify(file, null, 2)}\n`);
}

function parseReposFile(value: unknown): WorkspaceReposFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.repos)) {
    throw new DevtaskError("Invalid workspace repos metadata");
  }

  return {
    schemaVersion: 1,
    repos: value.repos.map(parseRepo)
  };
}

function parseRepo(value: unknown): WorkspaceRepo {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid workspace repo metadata");
  }

  const id = requireString(value, "id");
  assertValidRepoId(id);
  const repoPath = fs.realpathSync(resolvePaths(requireString(value, "repoPath")).root);
  const scope = value.scope === null || value.scope === undefined ? null : normalizeScope(requireString(value, "scope"));
  if (scope && !fs.existsSync(path.join(repoPath, scope))) {
    throw new DevtaskError(`Invalid workspace repo metadata: scope does not exist for ${id}`);
  }
  return {
    id,
    repoPath,
    scope,
    kind: value.kind === null || value.kind === undefined ? null : normalizeOptionalString(requireString(value, "kind")),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt")
  };
}

function resolveWorkspaceRelativePath(paths: DevtaskPaths, value: string): string {
  return path.resolve(paths.root, value);
}

function normalizeScope(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  if (path.isAbsolute(normalized)) {
    throw new DevtaskError("Workspace repo scope must be relative to the repo root");
  }
  const parts = normalized.split(/[\\/]+/);
  if (parts.includes("..")) {
    throw new DevtaskError("Workspace repo scope must not contain parent directory segments");
  }
  return parts.join(path.sep);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatRepoScope(repoPath: string, scope: string | null): string {
  return scope ? `${repoPath}:${scope}` : repoPath;
}

function assertValidRepoId(id: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new DevtaskError("Workspace repo id may only contain letters, numbers, dots, underscores, and dashes");
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid workspace repo metadata: ${field} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
