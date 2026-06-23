import fs from "node:fs";
import type { DevtaskPaths } from "../infra/paths.js";
import { taskStoragePaths, workItemDir, workItemRepoPlansDir, workItemResultsDir, workItemSpecPath } from "../infra/paths.js";
import { hasTaskPlan } from "../repo-plan.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { getTask } from "../storage/task-store.js";
import { getWorkItem } from "../storage/work-store.js";

export interface WorkDiagnostic {
  workId: string;
  status: string;
  next: string;
  waitingOn: string;
  reason: string;
  missingArtifacts: string[];
  warnings: string[];
  tasks: RepoTaskDiagnostic[];
}

export interface RepoTaskDiagnostic {
  repoId: string;
  taskId: string;
  status: string;
  branch: string;
  prUrl: string | null;
  resultSummary: string | null;
  failCount: number;
  maxRetries: number;
  next: string;
  waitingOn: string;
  reason: string;
  missingArtifacts: string[];
}

export function getWorkDiagnostics(paths: DevtaskPaths, workId: string): WorkDiagnostic {
  const item = getWorkItem(paths, workId);
  const hasSpec = fs.existsSync(workItemSpecPath(paths, workId));
  const hasPlan = fs.existsSync(`${workItemDir(paths, workId)}/plan.md`);
  const hasRepoPlans = fs.existsSync(workItemRepoPlansDir(paths, workId))
    && fs.readdirSync(workItemRepoPlansDir(paths, workId)).some((entry) => entry.endsWith(".md"));
  const materialization = readWorkMaterialization(paths, workId);

  if (!materialization) {
    return {
      workId,
      status: item.status,
      next: !hasSpec
        ? `devtask work spec ${shellQuote(workId)}`
        : !hasPlan
          ? `devtask work plan ${shellQuote(workId)}`
          : hasRepoPlans
            ? `devtask work materialize ${shellQuote(workId)}`
            : `devtask work repo-plan ${shellQuote(workId)}`,
      waitingOn: !hasSpec ? "spec" : !hasPlan ? "plan" : hasRepoPlans ? "materialization" : "repo-plan",
      reason: !hasSpec
        ? "The refined spec artifact does not exist yet."
        : !hasPlan
          ? "The global plan artifact does not exist yet."
          : hasRepoPlans
            ? "Repo plans exist, but repo tasks and worktrees have not been materialized yet."
            : "The work is planned, but repo-level plans have not been produced yet.",
      missingArtifacts: [
        !hasSpec ? "spec.md" : null,
        hasSpec && !hasPlan ? "plan.md" : null,
        hasPlan && !hasRepoPlans ? "repo-plans/*.md" : null,
        hasRepoPlans ? "local/work/<work-id>/materialization.json" : null
      ].filter((value): value is string => Boolean(value)),
      warnings: [],
      tasks: []
    };
  }

  const reviewResults = readWorkResultIndex(paths, workId, "review");
  const ciResults = readWorkResultIndex(paths, workId, "ci");
  const ciWatchResults = readWorkResultIndex(paths, workId, "ci-watch");
  const diagnostics = materialization.tasks.map((task) => {
    const storagePaths = taskStoragePaths(paths, task.repoPath);
    const meta = getTask(storagePaths, task.taskId);
    const hasRepoPlan = hasTaskPlan(storagePaths, task.taskId);
    const review = reviewResults.get(task.repoId) ?? "-";
    const ci = ciWatchResults.get(task.repoId) ?? ciResults.get(task.repoId) ?? "-";
    const logic = buildRepoTaskDiagnosticLogic(workId, task.repoId, task.taskId, meta.status, meta.runtime?.reason ?? meta.resultSummary, hasRepoPlan, meta.prUrl !== null, review, ci);
    return {
      repoId: task.repoId,
      taskId: task.taskId,
      status: meta.status,
      branch: meta.branch,
      prUrl: meta.prUrl,
      resultSummary: meta.resultSummary,
      failCount: meta.failCount,
      maxRetries: meta.maxRetries,
      ...logic,
    };
  });

  const waiting = diagnostics.find((entry) => entry.status === "blocked" || entry.status === "failed")
    ?? diagnostics.find((entry) => entry.waitingOn !== "complete")
    ?? diagnostics[0];

  return {
    workId,
    status: item.status,
    next: waiting?.next ?? `devtask work inspect ${shellQuote(workId)}`,
    waitingOn: waiting?.waitingOn ?? "complete",
    reason: waiting?.reason ?? "No pending diagnostic signals.",
    missingArtifacts: waiting?.missingArtifacts ?? [],
    warnings: [],
    tasks: diagnostics
  };
}

type TaskDiagnosticLogic = { next: string; waitingOn: string; reason: string; missingArtifacts: string[] };

function buildRepoTaskDiagnosticLogic(
  workId: string,
  repoId: string,
  taskId: string,
  status: string,
  runtimeReason: string | null,
  hasRepoPlan: boolean,
  hasPr: boolean,
  review: string,
  ci: string
): TaskDiagnosticLogic {
  if (!hasRepoPlan) {
    return {
      next: `devtask work repo-plan ${shellQuote(workId)}`,
      waitingOn: "repo-plan",
      reason: "The repo task plan artifact is missing.",
      missingArtifacts: ["plan.md"]
    };
  }
  if (status === "created" || status === "planned" || status === "ready") {
    return {
      next: `devtask work execute ${shellQuote(workId)}`,
      waitingOn: "execution",
      reason: "The repo task is planned but execution has not started yet.",
      missingArtifacts: []
    };
  }
  if (status === "running") {
    return {
      next: `devtask work execute attach ${shellQuote(workId)} ${shellQuote(repoId)}`,
      waitingOn: "execution",
      reason: runtimeReason ?? "An execution session is active.",
      missingArtifacts: []
    };
  }
  if (status === "paused") {
    return {
      next: `devtask work execute ${shellQuote(workId)}`,
      waitingOn: "execution",
      reason: runtimeReason ?? "Execution is paused and must be resumed.",
      missingArtifacts: []
    };
  }
  if (status === "blocked" || status === "failed") {
    return {
      next: `devtask work inspect ${shellQuote(workId)}`,
      waitingOn: "unblock",
      reason: runtimeReason ?? `The repo task is ${status}.`,
      missingArtifacts: []
    };
  }
  if (review === "-") {
    return {
      next: `devtask work review ${shellQuote(workId)}`,
      waitingOn: "review",
      reason: "Execution completed, but no review result exists yet.",
      missingArtifacts: [`reviews/${repoId}.json`]
    };
  }
  if (!hasPr) {
    return {
      next: `devtask work pr ${shellQuote(workId)}`,
      waitingOn: "pr",
      reason: "Review exists, but no pull request is recorded yet.",
      missingArtifacts: []
    };
  }
  if (ci === "-" || ci === "skipped") {
    return {
      next: `devtask work ci-watch ${shellQuote(workId)}`,
      waitingOn: "ci",
      reason: "The pull request exists, but CI has not been recorded yet.",
      missingArtifacts: ["results/ci-watch.json"]
    };
  }
  if (ci === "running") {
    return {
      next: `devtask work ci-watch ${shellQuote(workId)}`,
      waitingOn: "ci",
      reason: "CI watch is still polling for a terminal provider result.",
      missingArtifacts: []
    };
  }
  if (ci === "max-attempts" || ci === "fix-failed" || ci === "validation-failed" || ci === "unknown") {
    return {
      next: `devtask work inspect ${shellQuote(workId)}`,
      waitingOn: "unblock",
      reason: `CI watch reached a terminal non-success state: ${ci}.`,
      missingArtifacts: []
    };
  }
  return {
    next: `devtask work inspect ${shellQuote(workId)}`,
    waitingOn: "complete",
    reason: `The repo task has reached CI state: ${ci}.`,
    missingArtifacts: []
  };
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
    return new Map(
      value.tasks
        .map((task) => {
          const repoId = typeof task.repoId === "string" ? task.repoId : null;
          const resultStatus = typeof task.status === "string" ? task.status : null;
          return repoId && resultStatus ? ([repoId, resultStatus] as const) : null;
        })
        .filter((entry): entry is readonly [string, string] => Boolean(entry))
    );
  } catch {
    return new Map();
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
