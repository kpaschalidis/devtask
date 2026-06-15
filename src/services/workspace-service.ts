import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resolvePaths,
  resolveWorkspacePaths,
  resolveWorkspacePathsForId,
  resolveWorkspacePathsForInit,
  workspaceJsonPath
} from "../infra/paths.js";
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
import { addWorkspaceRepo, listWorkspaceRepos, seedLocalRepoBindingsFromHints } from "../storage/workspace-repos.js";
import { runCommandOrThrow } from "../infra/process-runner.js";

export interface InitWorkspaceOptions {
  register?: boolean;
}

export interface CreateWorkspaceOptions extends InitWorkspaceOptions {
  id: string;
  name: string;
}

export interface ImportWorkspaceOptions extends InitWorkspaceOptions {
  file: string;
  root?: string;
}

export interface ExportWorkspaceOptions {
  workspaceId: string;
  outFile: string;
}

export function initializeCurrentWorkspace(start = process.cwd(), options: InitWorkspaceOptions = {}): {
  paths: DevtaskPaths;
  registered: GlobalWorkspaceEntry | null;
} {
  const paths = resolveWorkspacePathsForInit(start);
  initializeWorkspace(paths);
  if (fs.existsSync(path.join(paths.root, ".git"))) {
    initializeStore(resolvePaths(paths.root));
    if (listWorkspaceRepos(paths).length === 0) {
      addWorkspaceRepo(paths, { id: "app", repoPath: ".", kind: "repo" });
    }
  }

  return {
    paths,
    registered: options.register === false ? null : registerWorkspace(paths)
  };
}

export function createWorkspace(start = process.cwd(), options: CreateWorkspaceOptions): {
  paths: DevtaskPaths;
  registered: GlobalWorkspaceEntry | null;
} {
  const root = path.resolve(start);
  const paths = resolveWorkspacePathsForId(root, options.id);
  initializeWorkspace(paths);
  fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  writeWorkspaceMetadata(paths, options.id, options.name);
  if (fs.existsSync(path.join(root, ".git"))) {
    initializeStore(resolvePaths(root));
    if (listWorkspaceRepos(paths).length === 0) {
      addWorkspaceRepo(paths, { id: "app", repoPath: ".", kind: "repo" });
    }
  }
  return {
    paths,
    registered: options.register === false ? null : registerWorkspace(paths, options.id)
  };
}

export async function exportWorkspaceBundle(
  options: ExportWorkspaceOptions
): Promise<{ workspace: GlobalWorkspaceEntry; outFile: string }> {
  const workspace = requireRegisteredWorkspace(options.workspaceId);
  const paths = resolveWorkspacePaths(workspace.path);
  const sharedDir = paths.sharedDir;
  const outFile = path.resolve(options.outFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await runCommandOrThrow("zip", ["-qr", outFile, "."], { cwd: sharedDir });
  return { workspace, outFile };
}

export async function importWorkspaceBundle(options: ImportWorkspaceOptions): Promise<{
  paths: DevtaskPaths;
  registered: GlobalWorkspaceEntry | null;
}> {
  const file = path.resolve(options.file);
  if (!fs.existsSync(file)) {
    throw new Error(`Workspace bundle does not exist: ${file}`);
  }

  const root = path.resolve(options.root ?? process.cwd());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-import-"));
  try {
    await runCommandOrThrow("unzip", ["-q", file, "-d", tmpDir], { cwd: process.cwd() });
    const workspaceMeta = readImportedWorkspaceMetadata(tmpDir);
    const paths = resolveWorkspacePathsForId(root, workspaceMeta.id);
    initializeWorkspace(paths);
    copyDirectoryContents(tmpDir, paths.sharedDir);
    seedLocalRepoBindingsFromHints(paths);
    return {
      paths,
      registered: options.register === false ? null : registerWorkspace(paths, workspaceMeta.id)
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

export function getWorkspaceById(workspaceId: string): GlobalWorkspaceEntry {
  return requireRegisteredWorkspace(workspaceId);
}

function requireRegisteredWorkspace(workspaceId: string): GlobalWorkspaceEntry {
  const workspace = readGlobalIndex().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} is not registered`);
  }
  return workspace;
}

function writeWorkspaceMetadata(paths: DevtaskPaths, id: string, name: string): void {
  const now = new Date().toISOString();
  const filePath = workspaceJsonPath(paths);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        name,
        root: paths.root,
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )}\n`
  );
}

function readImportedWorkspaceMetadata(dir: string): { id: string; name: string } {
  const filePath = path.join(dir, "workspace.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("Workspace bundle is missing workspace.json");
  }
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { id?: unknown; name?: unknown };
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("Workspace bundle has invalid workspace id");
  }
  return {
    id: value.id.trim(),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : value.id.trim()
  };
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(source, target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}
