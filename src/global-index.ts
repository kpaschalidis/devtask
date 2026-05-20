import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { workGraphPath, workPlanPath } from "./work-planner.js";
import { getWorkItem, listWorkItems, type WorkItem } from "./work-store.js";
import { buildWorkspaceBoardRow } from "./board/workspace-board.js";

export interface GlobalWorkspaceEntry {
  id: string;
  path: string;
  kind: "workspace";
  lastSeenAt: string;
}

export interface GlobalRecentWorkEntry {
  workId: string;
  workspaceId: string;
  workspacePath: string;
  title: string;
  sourceType: string;
  status: string;
  updatedAt: string;
  planPath: string;
  graphPath: string;
}

export interface GlobalIndex {
  schemaVersion: 1;
  workspaces: GlobalWorkspaceEntry[];
  recentWork: GlobalRecentWorkEntry[];
  updatedAt: string;
}

export function globalDevtaskDir(): string {
  if (process.env.DEVTASK_HOME?.trim()) {
    return path.resolve(process.env.DEVTASK_HOME);
  }
  return path.join(os.homedir(), ".devtask");
}

export function globalIndexPath(): string {
  return path.join(globalDevtaskDir(), "index.json");
}

export function readGlobalIndex(): GlobalIndex {
  const filePath = globalIndexPath();
  if (!fs.existsSync(filePath)) {
    return emptyIndex();
  }
  return parseGlobalIndex(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

export function writeGlobalIndex(index: GlobalIndex): void {
  fs.mkdirSync(globalDevtaskDir(), { recursive: true });
  fs.writeFileSync(globalIndexPath(), `${JSON.stringify(index, null, 2)}\n`);
}

export function registerWorkspace(paths: DevtaskPaths, id = defaultWorkspaceId(paths.root)): GlobalWorkspaceEntry {
  const now = new Date().toISOString();
  const workspacePath = fs.realpathSync(paths.root);
  const index = readGlobalIndex();
  const existing = index.workspaces.find((workspace) => workspace.path === workspacePath);
  const entry: GlobalWorkspaceEntry = {
    id: existing?.id ?? uniqueWorkspaceId(index, id, workspacePath),
    path: workspacePath,
    kind: "workspace",
    lastSeenAt: now
  };
  writeGlobalIndex({
    schemaVersion: 1,
    workspaces: [...index.workspaces.filter((workspace) => workspace.path !== workspacePath), entry].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    recentWork: index.recentWork.map((work) =>
      work.workspacePath === workspacePath ? { ...work, workspaceId: entry.id, workspacePath } : work
    ),
    updatedAt: now
  });
  return entry;
}

export function removeWorkspaceFromIndex(idOrPath: string): GlobalWorkspaceEntry {
  const index = readGlobalIndex();
  const resolved = path.resolve(idOrPath);
  const workspace = index.workspaces.find((entry) => entry.id === idOrPath || entry.path === resolved);
  if (!workspace) {
    throw new DevtaskError(`Workspace ${idOrPath} is not registered`);
  }
  writeGlobalIndex({
    schemaVersion: 1,
    workspaces: index.workspaces.filter((entry) => entry.path !== workspace.path),
    recentWork: index.recentWork.filter((entry) => entry.workspacePath !== workspace.path),
    updatedAt: new Date().toISOString()
  });
  return workspace;
}

export async function updateRecentWork(paths: DevtaskPaths, item: WorkItem): Promise<GlobalRecentWorkEntry> {
  const workspace = registerWorkspace(paths);
  const entry = await buildRecentWorkEntry(paths, workspace, item);
  const index = readGlobalIndex();
  writeGlobalIndex({
    schemaVersion: 1,
    workspaces: index.workspaces,
    recentWork: [
      entry,
      ...index.recentWork.filter(
        (work) => !(work.workspacePath === entry.workspacePath && work.workId === entry.workId)
      )
    ]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100),
    updatedAt: new Date().toISOString()
  });
  return entry;
}

export async function refreshWorkspaceRecentWork(paths: DevtaskPaths): Promise<GlobalRecentWorkEntry[]> {
  const workspace = registerWorkspace(paths);
  const entries: GlobalRecentWorkEntry[] = [];
  for (const item of listWorkItems(paths)) {
    entries.push(await buildRecentWorkEntry(paths, workspace, item));
  }
  const index = readGlobalIndex();
  writeGlobalIndex({
    schemaVersion: 1,
    workspaces: index.workspaces,
    recentWork: [
      ...entries,
      ...index.recentWork.filter((work) => work.workspacePath !== workspace.path)
    ]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100),
    updatedAt: new Date().toISOString()
  });
  return entries;
}

export async function findIndexedWork(workId: string): Promise<GlobalRecentWorkEntry | null> {
  const index = readGlobalIndex();
  const exact = index.recentWork.find((work) => work.workId === workId);
  if (exact) {
    return exact;
  }

  for (const workspace of index.workspaces) {
    try {
      const paths = pathsForWorkspace(workspace.path);
      const item = getWorkItem(paths, workId);
      return updateRecentWork(paths, item);
    } catch {
      // Keep discovery best-effort; stale registered workspaces can be repaired with registry commands.
    }
  }
  return null;
}

export function pathsForWorkspace(workspacePath: string): DevtaskPaths {
  const root = fs.realpathSync(workspacePath);
  const baseDir = path.join(root, ".devtask");
  return {
    root,
    baseDir,
    configPath: path.join(baseDir, "config.json"),
    tasksDir: path.join(baseDir, "tasks"),
    worktreesDir: path.join(baseDir, "worktrees"),
    workDir: path.join(baseDir, "work")
  };
}

function emptyIndex(): GlobalIndex {
  return {
    schemaVersion: 1,
    workspaces: [],
    recentWork: [],
    updatedAt: new Date().toISOString()
  };
}

async function buildRecentWorkEntry(
  paths: DevtaskPaths,
  workspace: GlobalWorkspaceEntry,
  item: WorkItem
): Promise<GlobalRecentWorkEntry> {
  const boardRow = await buildWorkspaceBoardRow(paths, item);
  return {
    workId: item.id,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    title: item.source.title,
    sourceType: item.source.type,
    status: boardRow.status,
    updatedAt: boardRow.updatedAt,
    planPath: workPlanPath(paths, item.id),
    graphPath: workGraphPath(paths, item.id)
  };
}

function defaultWorkspaceId(root: string): string {
  return path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
}

function uniqueWorkspaceId(index: GlobalIndex, desired: string, workspacePath: string): string {
  const existing = new Set(index.workspaces.filter((entry) => entry.path !== workspacePath).map((entry) => entry.id));
  if (!existing.has(desired)) {
    return desired;
  }
  let suffix = 2;
  while (existing.has(`${desired}-${suffix}`)) {
    suffix += 1;
  }
  return `${desired}-${suffix}`;
}

function parseGlobalIndex(value: unknown): GlobalIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.workspaces) || !Array.isArray(value.recentWork)) {
    throw new DevtaskError(`Invalid global devtask index: ${globalIndexPath()}`);
  }
  return {
    schemaVersion: 1,
    workspaces: value.workspaces.map(parseWorkspaceEntry),
    recentWork: value.recentWork.map(parseRecentWorkEntry),
    updatedAt: requireString(value, "updatedAt")
  };
}

function parseWorkspaceEntry(value: unknown): GlobalWorkspaceEntry {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid global workspace entry");
  }
  return {
    id: requireString(value, "id"),
    path: requireString(value, "path"),
    kind: "workspace",
    lastSeenAt: requireString(value, "lastSeenAt")
  };
}

function parseRecentWorkEntry(value: unknown): GlobalRecentWorkEntry {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid global recent work entry");
  }
  return {
    workId: requireString(value, "workId"),
    workspaceId: requireString(value, "workspaceId"),
    workspacePath: requireString(value, "workspacePath"),
    title: requireString(value, "title"),
    sourceType: requireString(value, "sourceType"),
    status: requireString(value, "status"),
    updatedAt: requireString(value, "updatedAt"),
    planPath: requireString(value, "planPath"),
    graphPath: requireString(value, "graphPath")
  };
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid global devtask index: ${field} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
