import type { DevtaskPaths } from "../paths.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { cleanupWork } from "./work-service.js";

export interface WorktreeSummary {
  workId: string;
  repoId: string;
  taskId: string;
  branch: string;
  path: string;
}

export function listWorktrees(paths: DevtaskPaths, workId: string): WorktreeSummary[] {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    return [];
  }

  return materialization.tasks.map((task) => ({
    workId,
    repoId: task.repoId,
    taskId: task.taskId,
    branch: task.branch,
    path: task.worktreePath
  }));
}

export async function cleanupWorktrees(paths: DevtaskPaths, workId: string, dryRun = false) {
  return cleanupWork(paths, workId, { dryRun });
}
