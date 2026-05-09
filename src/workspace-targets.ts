import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths, workspaceTargetsPath } from "./paths.js";

export interface WorkspaceTarget {
  id: string;
  repoPath: string;
  scope: string | null;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTargetsFile {
  schemaVersion: 1;
  targets: WorkspaceTarget[];
}

export interface AddWorkspaceTargetOptions {
  id: string;
  repoPath: string;
  scope?: string | null;
  kind?: string | null;
}

export function listWorkspaceTargets(paths: DevtaskPaths): WorkspaceTarget[] {
  return [...readTargetsFile(paths).targets].sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkspaceTarget(paths: DevtaskPaths, id: string): WorkspaceTarget {
  const target = listWorkspaceTargets(paths).find((item) => item.id === id);
  if (!target) {
    throw new DevtaskError(`Workspace target ${id} does not exist`);
  }
  return target;
}

export function addWorkspaceTarget(paths: DevtaskPaths, options: AddWorkspaceTargetOptions): WorkspaceTarget {
  assertValidTargetId(options.id);
  const repoPaths = resolvePaths(resolveWorkspaceRelativePath(paths, options.repoPath));
  const repoPath = fs.realpathSync(repoPaths.root);
  const scope = normalizeScope(options.scope);
  const kind = normalizeOptionalString(options.kind);
  const scopePath = scope ? path.join(repoPath, scope) : repoPath;
  if (!fs.existsSync(scopePath)) {
    throw new DevtaskError(`Workspace target scope does not exist: ${scopePath}`);
  }

  const file = readTargetsFile(paths);
  if (file.targets.some((target) => target.id === options.id)) {
    throw new DevtaskError(`Workspace target ${options.id} already exists`);
  }

  const duplicate = file.targets.find((target) => target.repoPath === repoPath && target.scope === scope);
  if (duplicate) {
    throw new DevtaskError(`Workspace target ${duplicate.id} already uses repo/scope ${formatRepoScope(repoPath, scope)}`);
  }

  const now = new Date().toISOString();
  const target: WorkspaceTarget = {
    id: options.id,
    repoPath,
    scope,
    kind,
    createdAt: now,
    updatedAt: now
  };
  writeTargetsFile(paths, {
    schemaVersion: 1,
    targets: [...file.targets, target]
  });
  return target;
}

export function removeWorkspaceTarget(paths: DevtaskPaths, id: string): WorkspaceTarget {
  const file = readTargetsFile(paths);
  const target = file.targets.find((item) => item.id === id);
  if (!target) {
    throw new DevtaskError(`Workspace target ${id} does not exist`);
  }
  writeTargetsFile(paths, {
    schemaVersion: 1,
    targets: file.targets.filter((item) => item.id !== id)
  });
  return target;
}

function readTargetsFile(paths: DevtaskPaths): WorkspaceTargetsFile {
  const filePath = workspaceTargetsPath(paths);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      targets: []
    };
  }

  return parseTargetsFile(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function writeTargetsFile(paths: DevtaskPaths, file: WorkspaceTargetsFile): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(workspaceTargetsPath(paths), `${JSON.stringify(file, null, 2)}\n`);
}

function parseTargetsFile(value: unknown): WorkspaceTargetsFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.targets)) {
    throw new DevtaskError("Invalid workspace targets metadata");
  }

  return {
    schemaVersion: 1,
    targets: value.targets.map(parseTarget)
  };
}

function parseTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid workspace target metadata");
  }

  const id = requireString(value, "id");
  assertValidTargetId(id);
  const repoPath = fs.realpathSync(resolvePaths(requireString(value, "repoPath")).root);
  const scope = value.scope === null || value.scope === undefined ? null : normalizeScope(requireString(value, "scope"));
  if (scope && !fs.existsSync(path.join(repoPath, scope))) {
    throw new DevtaskError(`Invalid workspace target metadata: scope does not exist for ${id}`);
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
    throw new DevtaskError("Workspace target scope must be relative to the target repo");
  }
  const parts = normalized.split(/[\\/]+/);
  if (parts.includes("..")) {
    throw new DevtaskError("Workspace target scope must not contain parent directory segments");
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

function assertValidTargetId(id: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new DevtaskError("Workspace target id may only contain letters, numbers, dots, underscores, and dashes");
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid workspace target metadata: ${field} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
