import fs from "node:fs";
import { cleanupTask, planTaskCleanup, type CleanupPlan } from "./cleanup.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths, workItemDir } from "./paths.js";
import { readWorkMaterialization } from "./work-materializer.js";
import type { WorkItem } from "./work-store.js";

export interface WorkCleanupOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface WorkCleanupResult {
  taskPlans: Array<{ target: string; plan: CleanupPlan }>;
  actions: string[];
  blockers: string[];
}

export async function cleanupWorkItem(
  paths: DevtaskPaths,
  item: WorkItem,
  options: WorkCleanupOptions = {}
): Promise<WorkCleanupResult> {
  const materialization = readWorkMaterialization(paths, item.id);
  const taskPlans: WorkCleanupResult["taskPlans"] = [];
  const blockers: string[] = [];
  const actions: string[] = [];

  if (materialization) {
    for (const task of materialization.tasks) {
      const repoPaths = resolvePaths(task.repoPath);
      const plan = await planTaskCleanup(repoPaths, task.taskId);
      taskPlans.push({ target: task.target, plan });
      blockers.push(...plan.blockers.map((blocker) => `${task.target}/${task.taskId}: ${blocker}`));
    }
  }

  const dir = workItemDir(paths, item.id);
  if (fs.existsSync(dir)) {
    actions.push(`remove work item metadata ${dir}`);
  } else {
    actions.push("nothing to remove");
  }

  if (blockers.length > 0 && !options.force) {
    return { taskPlans, actions, blockers };
  }

  if (!options.dryRun && materialization) {
    for (const task of materialization.tasks) {
      await cleanupTask(resolvePaths(task.repoPath), task.taskId, { force: options.force === true });
    }
  }

  if (!options.dryRun && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { taskPlans, actions, blockers };
}
