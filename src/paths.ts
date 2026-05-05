import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "./errors.js";

export interface DevtaskPaths {
  root: string;
  baseDir: string;
  tasksDir: string;
  worktreesDir: string;
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
  const root = findRepoRoot(start);
  const baseDir = path.join(root, ".devtask");

  return {
    root,
    baseDir,
    tasksDir: path.join(baseDir, "tasks"),
    worktreesDir: path.join(baseDir, "worktrees")
  };
}

export function taskDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.tasksDir, id);
}

export function taskMetaPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "meta.json");
}

export function taskMarkdownPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "task.md");
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
