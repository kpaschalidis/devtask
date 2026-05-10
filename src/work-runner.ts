import { DevtaskError } from "./errors.js";
import { readTaskMeta } from "./meta.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths, taskMetaPath } from "./paths.js";
import { isProcessAlive } from "./processes.js";
import type { TaskStatus } from "./types.js";
import { readApprovedWorkGraph, readWorkMaterialization } from "./work-materializer.js";
import type { WorkItem } from "./work-store.js";

export interface WorkRunReadyTask {
  target: string;
  taskId: string;
  repoPath: string;
  status: TaskStatus;
}

export interface WorkRunSkippedTask {
  target: string;
  taskId: string;
  repoPath: string;
  status: TaskStatus;
  reason: string;
}

export interface WorkRunPlan {
  ready: WorkRunReadyTask[];
  skipped: WorkRunSkippedTask[];
}

const RUNNABLE_STATUSES: TaskStatus[] = ["planned", "paused"];
const DEPENDENCY_COMPLETE_STATUSES: TaskStatus[] = ["done"];

export function planWorkRun(paths: DevtaskPaths, workItem: WorkItem): WorkRunPlan {
  const materialization = readWorkMaterialization(paths, workItem.id);
  if (!materialization) {
    throw new DevtaskError(`Work item ${workItem.id} has not been materialized. Run devtask work approve-plan ${workItem.id} first.`);
  }

  const graph = readApprovedWorkGraph(paths, workItem.id);
  const materializedByGraphId = new Map(materialization.tasks.map((task) => [task.graphTaskId, task]));
  const statusByGraphId = new Map<string, TaskStatus>();
  for (const task of materialization.tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    statusByGraphId.set(task.graphTaskId, readTaskMeta(taskMetaPath(repoPaths, task.taskId)).status);
  }

  const ready: WorkRunReadyTask[] = [];
  const skipped: WorkRunSkippedTask[] = [];
  for (const graphTask of graph.tasks) {
    const task = materializedByGraphId.get(graphTask.id);
    if (!task) {
      throw new DevtaskError(`Approved graph task ${graphTask.id} has not been materialized`);
    }

    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    const blockedDependency = graphTask.dependencies.find((dependency) => {
      if (dependency.type !== "run") {
        return false;
      }
      const dependencyStatus = statusByGraphId.get(dependency.task);
      return !dependencyStatus || !DEPENDENCY_COMPLETE_STATUSES.includes(dependencyStatus);
    });
    if (blockedDependency) {
      skipped.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        status: meta.status,
        reason: `waiting for ${blockedDependency.task}`
      });
      continue;
    }

    if (isProcessAlive(meta.supervisorPid)) {
      skipped.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        status: meta.status,
        reason: `already supervised by PID ${meta.supervisorPid}`
      });
      continue;
    }

    if (meta.status === "created") {
      skipped.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        status: meta.status,
        reason: "needs repo-plan"
      });
      continue;
    }

    if (!RUNNABLE_STATUSES.includes(meta.status)) {
      skipped.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        status: meta.status,
        reason: `not runnable from ${meta.status}`
      });
      continue;
    }

    ready.push({
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      status: meta.status
    });
  }

  return { ready, skipped };
}
