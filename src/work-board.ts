import { readConfig } from "./config.js";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths } from "./paths.js";
import { readStageLedger, STAGE_NAMES, type StageContract } from "./stage-contracts.js";
import { buildTaskReview } from "./task-inspection.js";
import { getTask } from "./task-store.js";
import { readWorkMaterialization } from "./work-materializer.js";
import { readWorkStageLedger, WORK_STAGE_NAMES, type WorkStageContract } from "./work-stage-contracts.js";
import { getWorkSpecState } from "./work-spec-state.js";
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
  const spec = getWorkSpecState(paths, item);
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    return [buildUnmaterializedWorkRow(paths, item, spec)];
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
      const specTask = spec.tasks.find((candidate) => candidate.taskId === task.taskId);
      const actionableRunSkip = runSkipped?.reason === "run complete" ? null : runSkipped;
      const waitingForSpec = spec.status !== "ready" && row.stage === "plan";
      const status = waitingForSpec
        ? specTaskStatus(spec.status, specTask)
        : row.stage === "run" && runReadyTaskIds.has(task.taskId)
          ? "ready"
          : row.stage === "run" && actionableRunSkip
            ? "waiting"
            : row.status;
      rows.push({
        target: task.target,
        task: row.id,
        stage: waitingForSpec ? "spec" : row.stage,
        status,
        last: latestStageSummary(readStageLedger(repoPaths, task.taskId)),
        blocked: waitingForSpec ? specTask?.reason ?? spec.reason ?? "-" : actionableRunSkip?.reason ?? "-",
        check: row.check,
        review: row.review,
        pr: row.pr,
        updated: row.updated,
        next: waitingForSpec ? spec.next : actionableRunSkip ? blockedWorkNext(item.id, actionableRunSkip.reason) : workLevelNext(item.id, row.stage, row.next)
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

function blockedWorkNext(workId: string, reason: string): string {
  if (reason === "needs repo-plan") {
    return `devtask work spec ${shellQuote(workId)}`;
  }
  return reason;
}

function buildUnmaterializedWorkRow(paths: DevtaskPaths, item: WorkItem, spec: ReturnType<typeof getWorkSpecState>): WorkBoardRow {
  const stages = readWorkStageLedger(paths, item.id);
  const latest = latestWorkStage(stages);
  return {
    target: "-",
    task: item.id,
    stage: "spec",
    status: workSpecBoardStatus(spec.status),
    last: latest ? `${latest.stage} ${latest.status}` : "-",
    blocked: spec.reason ?? latest?.reason ?? "-",
    check: "-",
    review: "-",
    pr: "-",
    updated: latest?.finishedAt ?? latest?.startedAt ?? item.updatedAt,
    next: spec.next
  };
}

function specTaskStatus(specStatus: ReturnType<typeof getWorkSpecState>["status"], task: ReturnType<typeof getWorkSpecState>["tasks"][number] | undefined): string {
  if (specStatus === "repo-planning") {
    return task?.status === "planned" ? "ready" : "running";
  }
  if (!task) {
    return "pending";
  }
  if (task.status === "planned") {
    return "ready";
  }
  return task.status;
}

function workSpecBoardStatus(status: ReturnType<typeof getWorkSpecState>["status"]): string {
  if (status === "ready") {
    return "pending";
  }
  if (status === "planning" || status === "repo-planning") {
    return "running";
  }
  if (status === "needs-plan" || status === "needs-materialization" || status === "needs-repo-plan") {
    return "pending";
  }
  return status;
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

function latestWorkStage(ledger: ReturnType<typeof readWorkStageLedger>): WorkStageContract | null {
  return WORK_STAGE_NAMES.map((stage) => ledger.stages[stage])
    .filter((stage): stage is WorkStageContract => Boolean(stage))
    .sort((a, b) => stageTime(b) - stageTime(a))
    .at(0) ?? null;
}

function stageTime(stage: { finishedAt: string | null; startedAt: string | null }): number {
  const value = Date.parse(stage.finishedAt ?? stage.startedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function workLevelNext(workId: string, stage: string, fallback: string): string {
  if (stage === "plan") {
    return `devtask work spec ${shellQuote(workId)}`;
  }
  if (["run", "check", "fix", "review"].includes(stage)) {
    return `devtask work exec ${shellQuote(workId)} --auto`;
  }
  if (["approve", "commit", "pr", "ci"].includes(stage)) {
    return `devtask work approve-exec ${shellQuote(workId)}`;
  }
  return fallback;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
