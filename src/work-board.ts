import fs from "node:fs";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, resolvePaths } from "./paths.js";
import { hasTaskPlan } from "./planner.js";
import { readWorkMaterialization } from "./work-materializer.js";
import { getTask } from "./task-store.js";
import type { WorkItem } from "./work-store.js";

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

  return materialization.tasks.map((task) => {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = getTask(repoPaths, task.taskId);
    const hasRepoPlan = hasTaskPlan(repoPaths, task.taskId);
    const stage = hasRepoPlan ? deriveTaskStage(meta.status) : "planning";
    return {
      target: task.target,
      task: task.taskId,
      stage,
      status: simplifyStatus(meta.status, hasRepoPlan),
      last: meta.status,
      blocked: meta.lifecycle?.runtime.reason ?? "-",
      check: "-",
      review: "-",
      pr: meta.prUrl ? "open" : "-",
      updated: meta.updatedAt,
      next: nextCommand(item.id, task.target, hasRepoPlan, meta.status, meta.tmuxSession !== null)
    };
  });
}

function buildUnmaterializedWorkRow(paths: DevtaskPaths, item: WorkItem): WorkBoardRow {
  const hasPlan = fs.existsSync(planMarkdownPath(paths, item.id));
  return {
    target: "-",
    task: item.id,
    stage: hasPlan ? "implement" : "planning",
    status: hasPlan ? "ready" : "pending",
    last: hasPlan ? "planned" : "created",
    blocked: "-",
    check: "-",
    review: "-",
    pr: "-",
    updated: item.updatedAt,
    next: hasPlan ? `devtask work implement ${shellQuote(item.id)}` : `devtask work plan ${shellQuote(item.id)}`
  };
}

function deriveTaskStage(status: string): string {
  switch (status) {
    case "created":
    case "planned":
      return "planning";
    case "running":
    case "paused":
      return "implementing";
    case "review":
      return "review";
    case "approved":
    case "pr-open":
      return "pr";
    case "ci-running":
    case "ci-failed":
    case "ci-passed":
      return "ci";
    case "done":
      return "done";
    case "blocked":
    case "failed":
    case "cancelled":
      return "blocked";
    default:
      return "implementing";
  }
}

function simplifyStatus(status: string, hasRepoPlan: boolean): string {
  if (!hasRepoPlan) {
    return "pending";
  }
  switch (status) {
    case "created":
    case "planned":
      return "ready";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "review":
      return "reviewing";
    case "approved":
      return "ready-for-pr";
    case "pr-open":
      return "pr-open";
    case "ci-running":
      return "ci-running";
    case "ci-failed":
      return "ci-failed";
    case "ci-passed":
      return "done";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

function nextCommand(workId: string, target: string, hasRepoPlan: boolean, status: string, hasSession: boolean): string {
  if (!hasRepoPlan) {
    return `devtask work plan ${shellQuote(workId)}`;
  }
  if (hasSession && (status === "running" || status === "paused")) {
    return `devtask session attach ${shellQuote(workId)} ${shellQuote(target)}`;
  }
  if (status === "approved") {
    return `devtask work pr ${shellQuote(workId)}`;
  }
  if (status === "pr-open") {
    return `devtask work ci ${shellQuote(workId)}`;
  }
  return `devtask work board ${shellQuote(workId)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
