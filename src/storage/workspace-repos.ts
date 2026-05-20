import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { resolvePaths, workspaceLocalReposPath, workspaceReposPath } from "../infra/paths.js";

export interface WorkspaceRepo {
  id: string;
  repoPath: string;
  scope: string | null;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SharedWorkspaceRepo {
  id: string;
  scope: string | null;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LocalWorkspaceRepoBinding {
  id: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceReposFile {
  schemaVersion: 1;
  repos: SharedWorkspaceRepo[];
}

interface WorkspaceLocalReposFile {
  schemaVersion: 1;
  repos: LocalWorkspaceRepoBinding[];
}

export interface AddWorkspaceRepoOptions {
  id: string;
  repoPath: string;
  scope?: string | null;
  kind?: string | null;
}

export function listWorkspaceRepos(paths: DevtaskPaths): WorkspaceRepo[] {
  const shared = readSharedReposFile(paths).repos;
  const localBindings = new Map(readLocalReposFile(paths).repos.map((repo) => [repo.id, repo]));
  return shared
    .flatMap((repo) => {
      const binding = localBindings.get(repo.id);
      if (!binding) {
        return [];
      }
      return [
        {
          id: repo.id,
          repoPath: binding.repoPath,
          scope: repo.scope,
          kind: repo.kind,
          createdAt: repo.createdAt,
          updatedAt: maxIso(repo.updatedAt, binding.updatedAt)
        }
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkspaceRepo(paths: DevtaskPaths, id: string): WorkspaceRepo {
  const repo = listWorkspaceRepos(paths).find((item) => item.id === id);
  if (!repo) {
    throw new DevtaskError(`Workspace repo ${id} does not exist or is not mapped locally`);
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

  const shared = readSharedReposFile(paths);
  if (shared.repos.some((repo) => repo.id === options.id)) {
    throw new DevtaskError(`Workspace repo ${options.id} already exists`);
  }

  const local = readLocalReposFile(paths);
  const duplicate = local.repos.find((repo) => repo.repoPath === repoPath);
  if (duplicate) {
    const duplicateShared = shared.repos.find((repo) => repo.id === duplicate.id);
    throw new DevtaskError(
      `Workspace repo ${duplicate.id} already uses repo/scope ${formatRepoScope(repoPath, duplicateShared?.scope ?? null)}`
    );
  }

  const now = new Date().toISOString();
  const sharedRepo: SharedWorkspaceRepo = {
    id: options.id,
    scope,
    kind,
    createdAt: now,
    updatedAt: now
  };
  const localBinding: LocalWorkspaceRepoBinding = {
    id: options.id,
    repoPath,
    createdAt: now,
    updatedAt: now
  };

  writeSharedReposFile(paths, {
    schemaVersion: 1,
    repos: [...shared.repos, sharedRepo]
  });
  writeLocalReposFile(paths, {
    schemaVersion: 1,
    repos: [...local.repos, localBinding]
  });

  return {
    id: sharedRepo.id,
    repoPath,
    scope: sharedRepo.scope,
    kind: sharedRepo.kind,
    createdAt: sharedRepo.createdAt,
    updatedAt: sharedRepo.updatedAt
  };
}

export function removeWorkspaceRepo(paths: DevtaskPaths, id: string): WorkspaceRepo {
  const shared = readSharedReposFile(paths);
  const repo = shared.repos.find((item) => item.id === id);
  if (!repo) {
    throw new DevtaskError(`Workspace repo ${id} does not exist`);
  }
  const local = readLocalReposFile(paths);
  const binding = local.repos.find((item) => item.id === id);

  writeSharedReposFile(paths, {
    schemaVersion: 1,
    repos: shared.repos.filter((item) => item.id !== id)
  });
  writeLocalReposFile(paths, {
    schemaVersion: 1,
    repos: local.repos.filter((item) => item.id !== id)
  });

  return {
    id: repo.id,
    repoPath: binding?.repoPath ?? "",
    scope: repo.scope,
    kind: repo.kind,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt
  };
}

function readSharedReposFile(paths: DevtaskPaths): WorkspaceReposFile {
  const filePath = workspaceReposPath(paths);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      repos: []
    };
  }

  return parseSharedReposFile(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function readLocalReposFile(paths: DevtaskPaths): WorkspaceLocalReposFile {
  const filePath = workspaceLocalReposPath(paths);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      repos: []
    };
  }

  return parseLocalReposFile(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function writeSharedReposFile(paths: DevtaskPaths, file: WorkspaceReposFile): void {
  fs.mkdirSync(paths.sharedDir, { recursive: true });
  fs.writeFileSync(workspaceReposPath(paths), `${JSON.stringify(file, null, 2)}\n`);
}

function writeLocalReposFile(paths: DevtaskPaths, file: WorkspaceLocalReposFile): void {
  fs.mkdirSync(paths.localDir, { recursive: true });
  fs.writeFileSync(workspaceLocalReposPath(paths), `${JSON.stringify(file, null, 2)}\n`);
}

function parseSharedReposFile(value: unknown): WorkspaceReposFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.repos)) {
    throw new DevtaskError("Invalid workspace repos metadata");
  }

  return {
    schemaVersion: 1,
    repos: value.repos.map(parseSharedRepo)
  };
}

function parseLocalReposFile(value: unknown): WorkspaceLocalReposFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.repos)) {
    throw new DevtaskError("Invalid local workspace repo metadata");
  }

  return {
    schemaVersion: 1,
    repos: value.repos.map(parseLocalBinding)
  };
}

function parseSharedRepo(value: unknown): SharedWorkspaceRepo {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid workspace repo metadata");
  }

  const id = requireString(value, "id");
  assertValidRepoId(id);
  return {
    id,
    scope: value.scope === null || value.scope === undefined ? null : normalizeScope(requireString(value, "scope")),
    kind: value.kind === null || value.kind === undefined ? null : normalizeOptionalString(requireString(value, "kind")),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt")
  };
}

function parseLocalBinding(value: unknown): LocalWorkspaceRepoBinding {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid local workspace repo metadata");
  }

  const id = requireString(value, "id");
  assertValidRepoId(id);
  const repoPath = fs.realpathSync(resolvePaths(requireString(value, "repoPath")).root);
  return {
    id,
    repoPath,
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

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
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
