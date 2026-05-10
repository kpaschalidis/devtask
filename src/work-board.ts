import fs from "node:fs";
import { readConfig } from "./config.js";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths } from "./paths.js";
import { readStageLedger, STAGE_NAMES, type StageContract } from "./stage-contracts.js";
import { buildTaskReview } from "./task-inspection.js";
import { getTask } from "./task-store.js";
import { readWorkMaterialization } from "./work-materializer.js";
import { workGraphPath, workPlanPath } from "./work-planner.js";
import { planWorkRun } from "./work-runner.js";
import type { WorkItem } from "./work-store.js";
import { buildBoardRow } from "./workflow.js";

export interface WorkBoardRow {
  target: string;
  task: string;
  stage: string;
  status: string;
  last: string;
  blocked: string;
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

  const runPlan = safePlanWorkRun(paths, item);
  const runSkippedByTask = new Map(runPlan?.skipped.map((task) => [task.taskId, task]) ?? []);
  const runReadyTaskIds = new Set(runPlan?.ready.map((task) => task.taskId) ?? []);
  const rows: WorkBoardRow[] = [];
  for (const task of materialization.tasks) {
    try {
      const repoPaths = resolvePaths(task.repoPath);
      const config = readConfig(repoPaths);
      const row = buildBoardRow(await buildTaskReview(repoPaths, getTask(repoPaths, task.taskId)), config);
      const runSkipped = runSkippedByTask.get(task.taskId);
      const status = row.stage === "run" && runReadyTaskIds.has(task.taskId) ? "ready" : row.stage === "run" && runSkipped ? "waiting" : row.status;
      rows.push({
        target: task.target,
        task: row.id,
        stage: row.stage,
        status,
        last: latestStageSummary(readStageLedger(repoPaths, task.taskId)),
        blocked: runSkipped?.reason ?? "-",
        check: row.check,
        review: row.review,
        pr: row.pr,
        updated: row.updated,
        next: runSkipped?.reason ?? workLevelNext(item.id, row.stage, row.next)
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
        last: "-",
        blocked: "-",
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
    last: "-",
    blocked: "-",
    check: "-",
    review: "-",
    pr: "-",
    updated: item.updatedAt,
    next: readyForApproval ? `devtask work approve-plan ${shellQuote(item.id)}` : `devtask work plan ${shellQuote(item.id)}`
  };
}

function safePlanWorkRun(paths: DevtaskPaths, item: WorkItem): ReturnType<typeof planWorkRun> | null {
  try {
    return planWorkRun(paths, item);
  } catch {
    return null;
  }
}

function latestStageSummary(ledger: ReturnType<typeof readStageLedger>): string {
  const latest = STAGE_NAMES.map((stage) => ledger.stages[stage])
    .filter((stage): stage is StageContract => Boolean(stage))
    .sort((a, b) => stageTime(b) - stageTime(a))
    .at(0);
  return latest ? `${latest.stage} ${latest.status}` : "-";
}

function stageTime(stage: StageContract): number {
  const value = Date.parse(stage.finishedAt ?? stage.startedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function workLevelNext(workId: string, stage: string, fallback: string): string {
  if (stage === "plan") {
    return `devtask work repo-plan ${shellQuote(workId)}`;
  }
  if (["run", "check", "review", "approve", "commit", "pr", "ci"].includes(stage)) {
    return `devtask work ${stage} ${shellQuote(workId)}`;
  }
  return fallback;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
