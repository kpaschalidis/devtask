import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "./errors.js";

export interface DevtaskPaths {
  root: string;
  baseDir: string;
  configPath: string;
  tasksDir: string;
  worktreesDir: string;
  workDir: string;
}

function buildPaths(root: string): DevtaskPaths {
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
  return buildPaths(findRepoRoot(start));
}

export function findWorkspaceRoot(start = process.cwd()): string | null {
  let current = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(current, ".devtask", "workspace.json"))) {
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
    return buildPaths(workspaceRoot);
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
  return buildPaths(path.resolve(start));
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
  return path.join(paths.baseDir, "scripts");
}

export function workspaceJsonPath(paths: DevtaskPaths): string {
  return path.join(paths.baseDir, "workspace.json");
}

export function workspaceReposPath(paths: DevtaskPaths): string {
  return path.join(paths.baseDir, "repos.json");
}

export function workItemDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.workDir, id);
}

export function workItemJsonPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "work.json");
}

export function workItemStatePath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "state.md");
}

export function workItemSourcePath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "source.md");
}

export function workItemApprovedGraphPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "approved-graph.json");
}

export function workItemMaterializationPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "materialization.json");
}
