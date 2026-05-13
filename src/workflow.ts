import type { DevtaskConfig } from "./config.js";
import { STAGE_NAMES, type StageName, type StageStatus } from "./stage-contracts.js";
import type { TaskReview } from "./task-inspection.js";

export type NextActionKind =
  | "plan"
  | "run"
  | "continue"
  | "check"
  | "fix"
  | "review"
  | "approve"
  | "pr"
  | "ci"
  | "inspect"
  | "configure-check"
  | "wait"
  | "none";

export interface NextAction {
  kind: NextActionKind;
  command: string | null;
  reason: string;
  automatic: boolean;
}

export interface BoardRow {
  id: string;
  stage: string;
  status: string;
  check: string;
  review: string;
  pr: string;
  updated: string;
  next: string;
}

export function recommendNextAction(review: TaskReview, config: DevtaskConfig): NextAction {
  const id = review.meta.id;

  if (review.meta.status === "running") {
    return {
      kind: "wait",
      command: `devtask task logs -f ${id}`,
      reason: "Task is running.",
      automatic: false
    };
  }

  if (review.meta.status === "created") {
    return {
      kind: "plan",
      command: `devtask task plan ${id}`,
      reason: "Task has not been planned.",
      automatic: true
    };
  }

  if (review.meta.status === "planned") {
    return {
      kind: "run",
      command: `devtask task run ${id}`,
      reason: "Task has an accepted plan and is ready to run.",
      automatic: true
    };
  }

  if (review.meta.status === "paused") {
    return {
      kind: "continue",
      command: `devtask task continue ${id}`,
      reason: "Task is paused.",
      automatic: true
    };
  }

  if (review.meta.status === "failed") {
    const failedStage = latestFailedStage(review);
    if (failedStage === "plan") {
      return {
        kind: "plan",
        command: `devtask task plan ${id}`,
        reason: "Planning failed and can be retried.",
        automatic: false
      };
    }

    return {
      kind: "continue",
      command: `devtask task continue ${id}`,
      reason: "Worker failed and can be continued after inspection.",
      automatic: false
    };
  }

  if (review.meta.status === "review" || isCompletedRunAwaitingQualityGates(review)) {
    const check = latestStageState(review, "check");
    const agentReview = latestStageState(review, "review");

    if (config.verify.length === 0) {
      return {
        kind: "configure-check",
        command: "devtask config check <command...>",
        reason: "No deterministic check commands are configured.",
        automatic: false
      };
    }

    if (!isFresh(check.finishedAt, codeChangeBaseline(review))) {
      return {
        kind: "check",
        command: `devtask task check ${id}`,
        reason: "Checks have not passed for the current task state.",
        automatic: true
      };
    }

    if (check.status === "failed") {
      return {
        kind: "fix",
        command: `devtask task fix ${id} --from check`,
        reason: "Checks failed; run a fix agent with the failed check artifact.",
        automatic: false
      };
    }

    const latestCheckFinishedAt = check.finishedAt;
    if (!latestCheckFinishedAt) {
      return {
        kind: "check",
        command: `devtask task check ${id}`,
        reason: "Checks have not passed for the current task state.",
        automatic: true
      };
    }

    if (!isFresh(agentReview.finishedAt, latestCheckFinishedAt)) {
      return {
        kind: "review",
        command: `devtask task review ${id}`,
        reason: "Review agent has not reviewed the checked changes.",
        automatic: true
      };
    }

    if (agentReview.status === "passed") {
      return {
        kind: "approve",
        command: `devtask task approve ${id}`,
        reason: "Checks and agent review passed; human approval is required before PR creation.",
        automatic: false
      };
    }

    return {
      kind: "inspect",
      command: `devtask task inspect ${id}`,
      reason: "Review agent found issues or failed; inspect the review artifact.",
      automatic: false
    };
  }

  if (review.meta.status === "approved") {
    return {
      kind: "pr",
      command: `devtask task pr ${id}`,
      reason: "Task is approved and ready for a PR.",
      automatic: true
    };
  }

  if (review.meta.status === "pr-open") {
    const ci = review.stages.stages.ci;
    if (ci?.status === "skipped") {
      return {
        kind: "none",
        command: null,
        reason: ci.reason ?? "CI status is unavailable. Merge or check provider manually.",
        automatic: false
      };
    }

    return {
      kind: "ci",
      command: `devtask task ci ${id}`,
      reason: "PR is open; CI status can be checked.",
      automatic: true
    };
  }

  if (review.meta.status === "ci-failed") {
    return {
      kind: "continue",
      command: `devtask task continue ${id}`,
      reason: "CI failed; continue the task to fix the failure.",
      automatic: false
    };
  }

  if (review.meta.status === "ci-passed") {
    return {
      kind: "none",
      command: null,
      reason: "CI passed. Merge or mark done outside devtask.",
      automatic: false
    };
  }

  return {
    kind: "none",
    command: null,
    reason: `Task is ${review.meta.status}.`,
    automatic: false
  };
}

export function buildBoardRow(review: TaskReview, config: DevtaskConfig): BoardRow {
  const next = recommendNextAction(review, config);
  const lifecycle = describeLifecycle(review);
  return {
    id: review.meta.id,
    stage: lifecycle.stage,
    status: lifecycle.status,
    check: formatCheckState(review),
    review: formatReviewState(review),
    pr: review.meta.prUrl ? "open" : "-",
    updated: review.meta.updatedAt,
    next: next.command ?? next.reason
  };
}

function describeLifecycle(review: TaskReview): { stage: string; status: string } {
  if (review.meta.status === "created") {
    return { stage: "plan", status: "pending" };
  }

  if (review.meta.status === "planned") {
    return { stage: "run", status: "pending" };
  }

  if (review.meta.status === "running") {
    const fix = review.stages.stages.fix;
    if (fix?.status === "running") {
      return { stage: "fix", status: "running" };
    }
    return { stage: "run", status: "running" };
  }

  const latest = latestStage(review);
  if (latest && ["running", "failed", "blocked", "findings"].includes(latest.status)) {
    if (latest.stage === "check" && latest.status === "failed") {
      return { stage: "fix", status: "ready" };
    }
    return { stage: latest.stage, status: latest.status };
  }

  if (review.meta.status === "review" || isCompletedRunAwaitingQualityGates(review)) {
    return describeReviewLifecycle(review);
  }

  if (review.meta.status === "approved") {
    return { stage: "pr", status: "pending" };
  }

  if (review.meta.status === "pr-open") {
    const ci = review.stages.stages.ci;
    if (ci?.status === "skipped") {
      return { stage: "-", status: "ci-unavailable" };
    }
    return { stage: "ci", status: "pending" };
  }

  return { stage: "-", status: review.meta.status };
}

function describeReviewLifecycle(review: TaskReview): { stage: string; status: string } {
  const check = latestStageState(review, "check");
  if (!check.status || !isFresh(check.finishedAt, codeChangeBaseline(review))) {
    return { stage: "check", status: "pending" };
  }

  if (check.status === "failed") {
    return { stage: "fix", status: "ready" };
  }

  const agentReview = latestStageState(review, "review");
  if (!agentReview.status || !isFresh(agentReview.finishedAt, check.finishedAt ?? review.meta.updatedAt)) {
    return { stage: "review", status: "pending" };
  }

  if (check.status === "passed" && agentReview.status === "passed") {
    return { stage: "approve", status: "pending" };
  }

  return { stage: agentReview.status === "findings" ? "review" : "check", status: "pending" };
}

function isCompletedRunAwaitingQualityGates(review: TaskReview): boolean {
  const stages = review.stages.stages;
  return review.meta.status === "done" && stages.run?.status === "passed" && !stages.approve && !stages.pr && !stages.ci;
}

function latestFailedStage(review: TaskReview): StageName | null {
  const latest = latestStage(review);
  return latest?.status === "failed" ? latest.stage : null;
}

function latestStage(review: TaskReview): { stage: StageName; status: StageStatus; finishedAt: string | null } | null {
  const stages = STAGE_NAMES.map((stage) => review.stages.stages[stage])
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage))
    .sort((a, b) => stageTime(b) - stageTime(a));

  const latest = stages.at(0);
  return latest ? { stage: latest.stage, status: latest.status, finishedAt: latest.finishedAt } : null;
}

function stageTime(stage: { finishedAt: string | null; startedAt: string | null }): number {
  const value = Date.parse(stage.finishedAt ?? stage.startedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function formatCheckState(review: TaskReview): string {
  const check = latestStageState(review, "check");
  if (!check.status) {
    return "-";
  }

  if (!isFresh(check.finishedAt, codeChangeBaseline(review))) {
    return `${check.status}:stale`;
  }

  return check.status;
}

function formatReviewState(review: TaskReview): string {
  const agentReview = latestStageState(review, "review");
  if (!agentReview.status) {
    return "-";
  }

  const baseline = latestStageState(review, "check").finishedAt ?? review.meta.updatedAt;
  if (!isFresh(agentReview.finishedAt, baseline)) {
    return `${agentReview.status}:stale`;
  }

  return agentReview.status;
}

function codeChangeBaseline(review: TaskReview): string {
  const candidates = [review.stages.stages.run, review.stages.stages.fix]
    .map((stage) => stage?.finishedAt)
    .filter((finishedAt): finishedAt is string => Boolean(finishedAt))
    .sort();

  return candidates.at(-1) ?? review.meta.createdAt;
}

function latestStageState(
  review: TaskReview,
  stage: "check" | "review"
): { status: "passed" | "failed" | "findings" | null; finishedAt: string | undefined } {
  if (stage === "check" && review.latestVerification) {
    return {
      status: review.latestVerification.status,
      finishedAt: review.latestVerification.finishedAt
    };
  }

  if (stage === "review" && review.latestReviewAgent) {
    return {
      status: review.latestReviewAgent.status,
      finishedAt: review.latestReviewAgent.finishedAt
    };
  }

  const contract = review.stages.stages[stage];
  if (contract?.status === "passed" || contract?.status === "failed" || contract?.status === "findings") {
    return {
      status: contract.status,
      finishedAt: contract.finishedAt ?? undefined
    };
  }

  return {
    status: null,
    finishedAt: undefined
  };
}

function isFresh(finishedAt: string | undefined, baseline: string): boolean {
  if (!finishedAt) {
    return false;
  }

  return Date.parse(finishedAt) >= Date.parse(baseline);
}
