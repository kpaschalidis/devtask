import fs from "node:fs";
import { DevtaskError } from "./errors.js";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, resolvePaths, taskMetaPath } from "./paths.js";
import { recordStage } from "./stage-contracts.js";
import { readApprovedWorkGraph, readWorkMaterialization, type WorkGraphTask } from "./work-materializer.js";
import { readWorkPlan } from "./work-planner.js";
import type { WorkItem } from "./work-store.js";

export interface WorkRepoPlanResult {
  target: string;
  taskId: string;
  repoPath: string;
  planPath: string;
  status: "planned";
}

export function createWorkRepoPlans(paths: DevtaskPaths, workItem: WorkItem): WorkRepoPlanResult[] {
  const materialization = readWorkMaterialization(paths, workItem.id);
  if (!materialization) {
    throw new DevtaskError(`Work item ${workItem.id} has not been materialized. Run devtask work approve-plan ${workItem.id} first.`);
  }

  const graph = readApprovedWorkGraph(paths, workItem.id);
  const workPlan = readWorkPlan(paths, workItem.id);
  if (!workPlan) {
    throw new DevtaskError(`Work plan is empty. Run devtask work plan ${workItem.id} first.`);
  }

  const graphTasks = new Map(graph.tasks.map((task) => [task.id, task]));
  const results: WorkRepoPlanResult[] = [];
  for (const task of materialization.tasks) {
    const graphTask = graphTasks.get(task.graphTaskId);
    if (!graphTask) {
      throw new DevtaskError(`Materialized task ${task.taskId} references missing graph task ${task.graphTaskId}`);
    }

    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    if (!["created", "planned", "blocked"].includes(meta.status)) {
      throw new DevtaskError(`Task ${task.taskId} is ${meta.status}; repo planning is only available before the task runs`);
    }

    const planPath = planMarkdownPath(repoPaths, task.taskId);
    fs.writeFileSync(planPath, renderRepoPlan(workItem, workPlan, graphTask, graph.tasks));
    const plannedAt = new Date().toISOString();
    writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
      ...meta,
      status: "planned",
      updatedAt: plannedAt
    });
    recordStage(repoPaths, task.taskId, "plan", {
      status: "passed",
      input: {
        workId: workItem.id,
        approvedGraphPath: materialization.approvedGraphPath,
        graphTaskId: task.graphTaskId,
        target: task.target
      },
      output: {
        planPath
      },
      artifacts: [planPath],
      reason: null
    });
    results.push({
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      planPath,
      status: "planned"
    });
  }

  return results;
}

function renderRepoPlan(workItem: WorkItem, workPlan: string, task: WorkGraphTask, allTasks: WorkGraphTask[]): string {
  const dependencies = task.dependsOn.map((id) => allTasks.find((candidate) => candidate.id === id)).filter((value): value is WorkGraphTask => Boolean(value));
  const dependents = allTasks.filter((candidate) => candidate.dependsOn.includes(task.id));
  return [
    `# Repo Plan: ${task.id}`,
    "",
    "## Work Item",
    "",
    `- ID: ${workItem.id}`,
    `- Source: ${workItem.source.title}`,
    `- Source artifact: ${workItem.source.artifact}`,
    ...("url" in workItem.source ? [`- URL: ${workItem.source.url}`] : []),
    "",
    "## Repo Goal",
    "",
    task.goal,
    "",
    "## Ownership",
    "",
    ...(task.owns.length ? task.owns.map((item) => `- ${item}`) : ["- No explicit ownership paths provided by the approved graph."]),
    "",
    "## Dependencies",
    "",
    ...(dependencies.length
      ? dependencies.map((dependency) => `- ${dependency.id} (${dependency.target}): ${dependency.goal}`)
      : ["- none"]),
    "",
    "## Downstream Tasks",
    "",
    ...(dependents.length ? dependents.map((dependent) => `- ${dependent.id} (${dependent.target})`) : ["- none"]),
    "",
    "## Work-Level Plan",
    "",
    workPlan.trim(),
    "",
    "## Implementation Instructions",
    "",
    "- Implement only the repo-local goal and ownership scope above.",
    "- Follow local conventions in this repository.",
    "- Do not assume other target repositories are available in this worktree.",
    "- If the approved graph is wrong or incomplete, stop and report the blocker instead of expanding scope silently.",
    "- Keep changes scoped to this task's ownership boundaries unless the existing code requires a smaller adjacent change.",
    "",
    "## Validation",
    "",
    "- Run the repo-local checks configured for this task.",
    "- Add or update focused tests for the changed behavior.",
    "- Record blockers in task state if implementation cannot proceed.",
    ""
  ].join("\n");
}
