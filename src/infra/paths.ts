import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { DevtaskError } from "./errors.js";

export interface DevtaskPaths {
  root: string;
  baseDir: string;
  markerDir: string;
  sharedDir: string;
  localDir: string;
  workspaceId: string | null;
  configPath: string;
  tasksDir: string;
  worktreesDir: string;
  workDir: string;
}

interface WorkspaceMarker {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  createdAt: string;
}

function buildRepoPaths(root: string): DevtaskPaths {
  const baseDir = path.join(root, ".devtask");

  return {
    root,
    baseDir,
    markerDir: baseDir,
    sharedDir: baseDir,
    localDir: baseDir,
    workspaceId: null,
    configPath: path.join(baseDir, "config.json"),
    tasksDir: path.join(baseDir, "tasks"),
    worktreesDir: path.join(baseDir, "worktrees"),
    workDir: path.join(baseDir, "work")
  };
}

function buildWorkspacePaths(root: string, workspaceId: string): DevtaskPaths {
  const baseDir = path.join(globalWorkspacesDir(), workspaceId);
  const sharedDir = path.join(baseDir, "shared");
  const localDir = path.join(baseDir, "local");
  return {
    root,
    baseDir,
    markerDir: path.join(root, ".devtask"),
    sharedDir,
    localDir,
    workspaceId,
    configPath: path.join(sharedDir, "config.json"),
    tasksDir: path.join(localDir, "tasks"),
    worktreesDir: path.join(localDir, "worktrees"),
    workDir: path.join(sharedDir, "work")
  };
}

export function resolveWorkspacePathsForId(root: string, workspaceId: string): DevtaskPaths {
  return buildWorkspacePaths(path.resolve(root), workspaceId);
}

export function globalDevtaskDir(): string {
  if (process.env.DEVTASK_HOME?.trim()) {
    return path.resolve(process.env.DEVTASK_HOME);
  }
  return path.join(os.homedir(), ".devtask");
}

export function globalWorkspacesDir(): string {
  return path.join(globalDevtaskDir(), "workspaces");
}

export function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new DevtaskError(`No git repository found from ${path.resolve(start)}`);
    }

    current = parent;
  }
}

export function resolvePaths(start = process.cwd()): DevtaskPaths {
  return buildRepoPaths(findRepoRoot(start));
}

export function findWorkspaceRoot(start = process.cwd()): string | null {
  let current = path.resolve(start);

  while (true) {
    if (fs.existsSync(workspaceMarkerPath(current))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function resolveWorkspacePaths(start = process.cwd()): DevtaskPaths {
  const workspaceRoot = findWorkspaceRoot(start);
  if (workspaceRoot) {
    return buildWorkspacePaths(workspaceRoot, readWorkspaceMarker(workspaceRoot).workspaceId);
  }

  try {
    return resolvePaths(start);
  } catch {
    throw new DevtaskError(
      `No devtask workspace or git repository found from ${path.resolve(start)}. Run devtask init first.`
    );
  }
}

export function resolveWorkspacePathsForInit(start = process.cwd()): DevtaskPaths {
  const root = path.resolve(start);
  const markerPath = workspaceMarkerPath(root);
  if (fs.existsSync(markerPath)) {
    return buildWorkspacePaths(root, readWorkspaceMarker(root).workspaceId);
  }
  return buildWorkspacePaths(root, deriveWorkspaceId(root));
}

export function taskStoragePaths(paths: DevtaskPaths, repoRoot?: string): DevtaskPaths {
  if (paths.workspaceId) {
    return paths;
  }
  return repoRoot ? resolvePaths(repoRoot) : paths;
}

export function taskDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.tasksDir, id);
}

export function startupDir(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "startup");
}

export function taskMetaPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "meta.json");
}

export function taskMarkdownPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "task.md");
}

export function planMarkdownPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "plan.md");
}

export function stateMarkdownPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "state.md");
}

export function resultJsonPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "result.json");
}

export function worktreePath(paths: DevtaskPaths, id: string): string {
  return path.join(paths.worktreesDir, id);
}

export function scriptsDir(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "scripts");
}

export function workspaceJsonPath(paths: DevtaskPaths): string {
  return path.join(paths.sharedDir, "workspace.json");
}

export function workspaceReposPath(paths: DevtaskPaths): string {
  return path.join(paths.sharedDir, "repos.json");
}

export function workspaceLocalReposPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "repos.local.json");
}

export function workspaceMarkerPath(root: string): string {
  return path.join(root, ".devtask", "workspace.json");
}

export function workItemDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.workDir, id);
}

export function workItemJsonPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "work.json");
}

export function workItemStatePath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "state.md");
}

export function workItemSourcePath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "source.md");
}

export function workItemSpecPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "spec.md");
}

export function workItemGraphSnapshotPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "graph.snapshot.json");
}

export function workItemMaterializationPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "materialization.json");
}

export function workItemResultsDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "results");
}

export function workItemRepoPlansDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "repo-plans");
}

export function workItemRepoPlanPath(paths: DevtaskPaths, id: string, repoId: string): string {
  return path.join(workItemRepoPlansDir(paths, id), `${repoId}.md`);
}

export function workItemLocalDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.localDir, "work", id);
}

export const GLOBAL_PHASES = new Set(["spec", "plan", "compound"]);

export function phaseRunDir(
  paths: DevtaskPaths,
  workId: string,
  phase: string,
  repoId: string | null
): string {
  const base = path.join(workItemLocalDir(paths, workId), "phases", phase);
  return GLOBAL_PHASES.has(phase) || !repoId ? base : path.join(base, repoId);
}

export function workItemLocalStatePath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "state.md");
}

export function workItemReviewDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "reviews");
}

export function workItemSpecRunsDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "spec-runs");
}

export function workItemPlanRunsDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemLocalDir(paths, id), "plans");
}

export function workItemPhaseRunsDir(paths: DevtaskPaths, id: string, phase: string): string {
  return phaseRunDir(paths, id, phase, null);
}

export function workItemRepoPhaseRunsDir(paths: DevtaskPaths, id: string, phase: string, repoId: string): string {
  return phaseRunDir(paths, id, phase, repoId);
}

export function readWorkspaceMarker(root: string): WorkspaceMarker {
  const markerPath = workspaceMarkerPath(root);
  const value = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<WorkspaceMarker>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.workspaceId !== "string" ||
    !value.workspaceId.trim() ||
    typeof value.root !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new DevtaskError(`Invalid devtask workspace marker: ${markerPath}`);
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId.trim(),
    root: value.root,
    createdAt: value.createdAt
  };
}

export function writeWorkspaceMarker(root: string, workspaceId: string, createdAt: string): void {
  const markerDir = path.join(root, ".devtask");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(
    workspaceMarkerPath(root),
    `${JSON.stringify({ schemaVersion: 1, workspaceId, root, createdAt }, null, 2)}\n`
  );
}

function deriveWorkspaceId(root: string): string {
  const name = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const suffix = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `${name}-${suffix}`;
}
