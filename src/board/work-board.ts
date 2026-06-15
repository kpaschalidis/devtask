import fs from "node:fs";
import type { DevtaskPaths } from "../infra/paths.js";
import { planMarkdownPath, taskStoragePaths, workItemRepoPlansDir, workItemResultsDir, workItemSpecPath } from "../infra/paths.js";
import { hasTaskPlan } from "../repo-plan.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { getTask } from "../storage/task-store.js";
import { getWorkItem } from "../storage/work-store.js";

export interface RepoTaskBoardRow {
  repo: string;
  task: string;
  phase: string;
  status: string;
  last: string;
  blocked: string;
  check: string;
  review: string;
  pr: string;
  updated: string;
  next: string;
}

export async function buildWorkBoard(paths: DevtaskPaths, workId: string): Promise<RepoTaskBoardRow[]> {
  return buildWorkBoardRows(paths, getWorkItem(paths, workId));
}

export async function buildWorkBoardRows(
  paths: DevtaskPaths,
  item: ReturnType<typeof getWorkItem>
): Promise<RepoTaskBoardRow[]> {
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    return [buildUnmaterializedWorkRow(paths, item)];
  }

  const checkResults = readWorkResultIndex(paths, item.id, "check");
  const reviewResults = readWorkResultIndex(paths, item.id, "review");
  const verifyResults = readWorkResultIndex(paths, item.id, "verify");
  const ciResults = readWorkResultIndex(paths, item.id, "ci");
  const ciWatchResults = readWorkResultIndex(paths, item.id, "ci-watch");

  return materialization.tasks.map((task) => {
    const storagePaths = taskStoragePaths(paths, task.repoPath);
    const meta = getTask(storagePaths, task.taskId);
    const hasRepoPlan = hasTaskPlan(storagePaths, task.taskId);
    const check = checkResults.get(task.repoId) ?? "-";
    const review = reviewResults.get(task.repoId) ?? "-";
    const verify = verifyResults.get(task.repoId) ?? "-";
    const ci = ciWatchResults.get(task.repoId) ?? ciResults.get(task.repoId) ?? "-";
    const phase = hasRepoPlan ? deriveTaskPhase(meta.status, meta.prUrl !== null, ci) : "planning";
    return {
      repo: task.repoId,
      task: task.taskId,
      phase,
      status: simplifyStatus(meta.status, hasRepoPlan, meta.prUrl !== null, ci),
      last: meta.status,
      blocked: meta.runtime?.reason ?? "-",
      check: mergeSignals(check, verify),
      review,
      pr: meta.prUrl ? "open" : "-",
      updated: meta.updatedAt,
      next: nextCommand(item.id, task.repoId, hasRepoPlan, meta.status, meta.tmuxSession !== null, meta.prUrl !== null, check, review, ci)
    };
  });
}

function buildUnmaterializedWorkRow(
  paths: DevtaskPaths,
  item: ReturnType<typeof getWorkItem>
): RepoTaskBoardRow {
  const hasSpec = fs.existsSync(workItemSpecPath(paths, item.id));
  const hasPlan = fs.existsSync(planMarkdownPath(paths, item.id));
  const hasRepoPlans = fs.existsSync(workItemRepoPlansDir(paths, item.id))
    && fs.readdirSync(workItemRepoPlansDir(paths, item.id)).some((entry) => entry.endsWith(".md"));
  return {
    repo: "-",
    task: item.id,
    phase: hasPlan ? "planning" : hasSpec ? "spec" : "spec",
    status: hasPlan ? "planned" : hasSpec ? "spec-ready" : "pending",
    last: hasPlan ? "planned" : hasSpec ? "spec-ready" : "created",
    blocked: "-",
    check: "-",
    review: "-",
    pr: "-",
    updated: item.updatedAt,
    next: hasPlan
      ? hasRepoPlans
        ? `devtask work materialize ${shellQuote(item.id)}`
        : `devtask work repo-plan ${shellQuote(item.id)}`
      : hasSpec
        ? `devtask work plan ${shellQuote(item.id)}`
        : `devtask work spec ${shellQuote(item.id)}`
  };
}

function deriveTaskPhase(status: string, hasPr: boolean, ci: string): string {
  if (ci !== "-" && ci !== "skipped") {
    return "ci";
  }
  switch (status) {
    case "created":
    case "planned":
    case "ready":
      return "planning";
    case "running":
    case "paused":
      return "execute";
    case "done":
      return "done";
    case "blocked":
    case "failed":
      return "blocked";
    default:
      if (hasPr) {
        return "pr";
      }
      return "implementation";
  }
}

function simplifyStatus(status: string, hasRepoPlan: boolean, hasPr: boolean, ci: string): string {
  if (!hasRepoPlan) {
    return "pending";
  }
  if (ci === "passed") {
    return "done";
  }
  if (ci !== "-" && ci !== "skipped") {
    return `ci-${ci}`;
  }
  switch (status) {
    case "created":
    case "planned":
    case "ready":
      return "ready";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      if (hasPr) {
        return "pr-open";
      }
      return status;
  }
}

function nextCommand(
  workId: string,
  repoId: string,
  hasRepoPlan: boolean,
  status: string,
  hasSession: boolean,
  hasPr: boolean,
  check: string,
  review: string,
  ci: string
): string {
  if (!hasRepoPlan) {
    return `devtask work repo-plan ${shellQuote(workId)}`;
  }
  if (status === "created" || status === "planned" || status === "ready") {
    return `devtask work execute ${shellQuote(workId)}`;
  }
  if (hasSession && (status === "running" || status === "paused")) {
    return `devtask work execute attach ${shellQuote(workId)} ${shellQuote(repoId)}`;
  }
  if (check === "-") {
    return `devtask work check ${shellQuote(workId)}`;
  }
  if (review === "-") {
    return `devtask work review ${shellQuote(workId)}`;
  }
  if (!hasPr) {
    return `devtask work pr ${shellQuote(workId)}`;
  }
  if (ci === "-" || ci === "skipped") {
    return `devtask work ci-watch ${shellQuote(workId)}`;
  }
  if (ci === "running") {
    return `devtask work ci-watch ${shellQuote(workId)}`;
  }
  return `devtask work board ${shellQuote(workId)}`;
}

function readWorkResultIndex(paths: DevtaskPaths, workId: string, name: string): Map<string, string> {
  try {
    const filePath = `${workItemResultsDir(paths, workId)}/${name}.json`;
    if (!fs.existsSync(filePath)) {
      return new Map();
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      tasks?: Array<{ repoId?: unknown; status?: unknown }>;
    };
    if (!Array.isArray(value.tasks)) {
      return new Map();
    }
    const entries = value.tasks
      .map((task) => {
        const repoId = typeof task.repoId === "string" ? task.repoId : null;
        const status = typeof task.status === "string" ? task.status : null;
        return repoId && status ? ([repoId, status] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry));
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function mergeSignals(primary: string, secondary: string): string {
  if (primary !== "-" && secondary !== "-") {
    return `${primary}/${secondary}`;
  }
  return primary !== "-" ? primary : secondary;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
