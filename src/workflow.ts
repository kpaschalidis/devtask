import type { DevtaskConfig } from "./config.js";
import type { TaskReview } from "./task-inspection.js";

export type NextActionKind =
  | "run"
  | "continue"
  | "check"
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
      command: `devtask logs -f ${id}`,
      reason: "Task is running.",
      automatic: false
    };
  }

  if (review.meta.status === "created") {
    return {
      kind: "run",
      command: `devtask run ${id}`,
      reason: "Task has not started.",
      automatic: true
    };
  }

  if (review.meta.status === "paused") {
    return {
      kind: "continue",
      command: `devtask continue ${id}`,
      reason: "Task is paused.",
      automatic: true
    };
  }

  if (review.meta.status === "failed") {
    return {
      kind: "continue",
      command: `devtask continue ${id}`,
      reason: "Worker failed and can be continued after inspection.",
      automatic: false
    };
  }

  if (review.meta.status === "review") {
    if (config.verify.length === 0) {
      return {
        kind: "configure-check",
        command: "devtask config check <command...>",
        reason: "No deterministic check commands are configured.",
        automatic: false
      };
    }

    if (!isFresh(review.latestVerification?.finishedAt, review.meta.updatedAt)) {
      return {
        kind: "check",
        command: `devtask check ${id}`,
        reason: "Checks have not passed for the current task state.",
        automatic: true
      };
    }

    if (review.latestVerification?.status === "failed") {
      return {
        kind: "continue",
        command: `devtask continue ${id}`,
        reason: "Checks failed; the worker needs another pass.",
        automatic: false
      };
    }

    const latestCheckFinishedAt = review.latestVerification?.finishedAt;
    if (!latestCheckFinishedAt) {
      return {
        kind: "check",
        command: `devtask check ${id}`,
        reason: "Checks have not passed for the current task state.",
        automatic: true
      };
    }

    if (!isFresh(review.latestReviewAgent?.finishedAt, latestCheckFinishedAt)) {
      return {
        kind: "review",
        command: `devtask review ${id}`,
        reason: "Review agent has not reviewed the checked changes.",
        automatic: true
      };
    }

    if (review.latestReviewAgent?.status === "passed") {
      return {
        kind: "approve",
        command: `devtask approve ${id}`,
        reason: "Checks and agent review passed; human approval is required before PR creation.",
        automatic: false
      };
    }

    return {
      kind: "inspect",
      command: `devtask inspect ${id}`,
      reason: "Review agent found issues or failed; inspect the review artifact.",
      automatic: false
    };
  }

  if (review.meta.status === "approved") {
    return {
      kind: "pr",
      command: `devtask pr ${id}`,
      reason: "Task is approved and ready for a PR.",
      automatic: true
    };
  }

  if (review.meta.status === "pr-open") {
    return {
      kind: "ci",
      command: `devtask ci ${id}`,
      reason: "PR is open; CI status can be checked.",
      automatic: true
    };
  }

  if (review.meta.status === "ci-failed") {
    return {
      kind: "continue",
      command: `devtask continue ${id}`,
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
  return {
    id: review.meta.id,
    status: review.meta.status,
    check: formatCheckState(review),
    review: formatReviewState(review),
    pr: review.meta.prUrl ? "open" : "-",
    updated: review.meta.updatedAt,
    next: next.command ?? next.reason
  };
}

function formatCheckState(review: TaskReview): string {
  if (!review.latestVerification) {
    return "-";
  }

  if (!isFresh(review.latestVerification.finishedAt, review.meta.updatedAt)) {
    return `${review.latestVerification.status}:stale`;
  }

  return review.latestVerification.status;
}

function formatReviewState(review: TaskReview): string {
  if (!review.latestReviewAgent) {
    return "-";
  }

  const baseline = review.latestVerification?.finishedAt ?? review.meta.updatedAt;
  if (!isFresh(review.latestReviewAgent.finishedAt, baseline)) {
    return `${review.latestReviewAgent.status}:stale`;
  }

  return review.latestReviewAgent.status;
}

function isFresh(finishedAt: string | undefined, baseline: string): boolean {
  if (!finishedAt) {
    return false;
  }

  return Date.parse(finishedAt) >= Date.parse(baseline);
}
