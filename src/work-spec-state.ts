import fs from "node:fs";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, resolvePaths } from "./paths.js";
import { hasTaskPlan } from "./planner.js";
import { readStageLedger } from "./stage-contracts.js";
import { readWorkMaterialization } from "./work-materializer.js";
import { workGraphPath, workPlanPath } from "./work-planner.js";
import { readWorkStageLedger } from "./work-stage-contracts.js";
import type { WorkItem } from "./work-store.js";

export type WorkSpecStatus =
  | "needs-plan"
  | "needs-materialization"
  | "planning"
  | "needs-repo-plan"
  | "repo-planning"
  | "ready"
  | "failed";

export interface WorkSpecTaskState {
  target: string;
  taskId: string;
  repoPath: string;
  planPath: string;
  status: "missing" | "running" | "planned" | "failed";
  reason: string | null;
}

export interface WorkSpecState {
  status: WorkSpecStatus;
  next: string;
  reason: string | null;
  tasks: WorkSpecTaskState[];
}

export function getWorkSpecState(paths: DevtaskPaths, item: WorkItem): WorkSpecState {
  const workStages = readWorkStageLedger(paths, item.id).stages;
  const hasPlan = fs.existsSync(workPlanPath(paths, item.id));
  const hasGraph = fs.existsSync(workGraphPath(paths, item.id));
  const materialization = readWorkMaterialization(paths, item.id);

  if (workStages.plan?.status === "running" || (!materialization && workStages.spec?.status === "running")) {
    return state("planning", `devtask work board ${shellQuote(item.id)}`, "workspace planning is running", []);
  }

  if (workStages.plan?.status === "failed") {
    return state("failed", `devtask work spec ${shellQuote(item.id)} --refresh`, workStages.plan.reason ?? "workspace planning failed", []);
  }

  if (!hasPlan || !hasGraph) {
    return state("needs-plan", `devtask work spec ${shellQuote(item.id)}`, "workspace plan is missing", []);
  }

  if (!materialization) {
    return state("needs-materialization", `devtask work spec ${shellQuote(item.id)}`, "work graph has not been materialized", []);
  }

  const workRepoPlanningRunning = workStages.spec?.status === "running" || workStages["repo-plan"]?.status === "running";
  const tasks = materialization.tasks.map((task): WorkSpecTaskState => {
    const repoPaths = resolvePaths(task.repoPath);
    const planPath = planMarkdownPath(repoPaths, task.taskId);
    const planStage = readStageLedger(repoPaths, task.taskId).stages.plan;
    if (planStage?.status === "running") {
      return {
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath,
        status: "running",
        reason: "repo planning is running"
      };
    }
    if (hasTaskPlan(repoPaths, task.taskId)) {
      return {
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath,
        status: "planned",
        reason: null
      };
    }
    if (planStage?.status === "failed") {
      return {
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath,
        status: "failed",
        reason: planStage.reason ?? "repo planning failed"
      };
    }
    return {
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      planPath,
      status: "missing",
      reason: "repo plan is missing"
    };
  });

  if (tasks.some((task) => task.status === "failed")) {
    return state("failed", `devtask work spec ${shellQuote(item.id)}`, "one or more repo plans failed", tasks);
  }

  if (tasks.some((task) => task.status === "running")) {
    return state("repo-planning", `devtask work board ${shellQuote(item.id)}`, "repo planning is running", tasks);
  }

  if (tasks.some((task) => task.status === "missing")) {
    if (workRepoPlanningRunning) {
      return state("repo-planning", `devtask work board ${shellQuote(item.id)}`, "repo planning is running", tasks);
    }
    return state("needs-repo-plan", `devtask work spec ${shellQuote(item.id)}`, "one or more repo plans are missing", tasks);
  }

  return state("ready", `devtask work approve-spec ${shellQuote(item.id)}`, null, tasks);
}

function state(status: WorkSpecStatus, next: string, reason: string | null, tasks: WorkSpecTaskState[]): WorkSpecState {
  return {
    status,
    next,
    reason,
    tasks
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
