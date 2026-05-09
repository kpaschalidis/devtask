import fs from "node:fs";
import { readConfig } from "./config.js";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths } from "./paths.js";
import { buildTaskReview } from "./task-inspection.js";
import { getTask } from "./task-store.js";
import { readWorkMaterialization } from "./work-materializer.js";
import { workGraphPath, workPlanPath } from "./work-planner.js";
import type { WorkItem } from "./work-store.js";
import { buildBoardRow } from "./workflow.js";

export interface WorkBoardRow {
  target: string;
  task: string;
  stage: string;
  status: string;
  check: string;
  review: string;
  pr: string;
  updated: string;
  next: string;
}

export async function buildWorkBoardRows(paths: DevtaskPaths, item: WorkItem): Promise<WorkBoardRow[]> {
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    return [buildUnmaterializedWorkRow(paths, item)];
  }

  const rows: WorkBoardRow[] = [];
  for (const task of materialization.tasks) {
    try {
      const repoPaths = resolvePaths(task.repoPath);
      const config = readConfig(repoPaths);
      const row = buildBoardRow(await buildTaskReview(repoPaths, getTask(repoPaths, task.taskId)), config);
      rows.push({
        target: task.target,
        task: row.id,
        stage: row.stage,
        status: row.status,
        check: row.check,
        review: row.review,
        pr: row.pr,
        updated: row.updated,
        next: rewriteCommandForRepo(row.next, task.repoPath)
      });
    } catch (error) {
      if (!(error instanceof DevtaskError)) {
        throw error;
      }
      rows.push({
        target: task.target,
        task: task.taskId,
        stage: "task",
        status: "missing",
        check: "-",
        review: "-",
        pr: "-",
        updated: materialization.materializedAt,
        next: error.message
      });
    }
  }

  return rows;
}

function buildUnmaterializedWorkRow(paths: DevtaskPaths, item: WorkItem): WorkBoardRow {
  const hasGraph = fs.existsSync(workGraphPath(paths, item.id));
  const hasPlan = fs.existsSync(workPlanPath(paths, item.id));
  const readyForApproval = hasPlan && hasGraph;
  return {
    target: "-",
    task: item.id,
    stage: readyForApproval ? "approve-plan" : "plan",
    status: "pending",
    check: "-",
    review: "-",
    pr: "-",
    updated: item.updatedAt,
    next: readyForApproval ? `devtask work approve-plan ${shellQuote(item.id)}` : `devtask work plan ${shellQuote(item.id)}`
  };
}

function rewriteCommandForRepo(command: string, repoPath: string): string {
  if (!command.startsWith("devtask ")) {
    return command;
  }

  return `(cd ${shellQuote(repoPath)} && ${command})`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
