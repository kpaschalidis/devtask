import fs from "node:fs";
import { cleanupTask, planTaskCleanup, type CleanupPlan } from "./cleanup.js";
import type { DevtaskPaths } from "./infra/paths.js";
import { resolvePaths, workItemDir } from "./infra/paths.js";
import { readWorkMaterialization } from "./work-materializer.js";
import type { WorkItem } from "./storage/work-store.js";

export interface WorkCleanupOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface WorkCleanupResult {
  taskPlans: Array<{ repoId: string; plan: CleanupPlan }>;
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
      const plan = await planTaskCleanup(repoPaths, task.taskId, { keepMetadata: true });
      taskPlans.push({ repoId: task.repoId, plan });
      blockers.push(...plan.blockers.map((blocker) => `${task.repoId}/${task.taskId}: ${blocker}`));
    }
  }

  const dir = workItemDir(paths, item.id);
  if (fs.existsSync(dir)) {
    actions.push(`preserve work history ${dir}`);
  } else {
    actions.push("nothing to remove");
  }

  if (blockers.length > 0 && !options.force) {
    return { taskPlans, actions, blockers };
  }

  if (!options.dryRun && materialization) {
    for (const task of materialization.tasks) {
      await cleanupTask(resolvePaths(task.repoPath), task.taskId, {
        force: options.force === true,
        keepMetadata: true
      });
    }
  }

  return { taskPlans, actions, blockers };
}
