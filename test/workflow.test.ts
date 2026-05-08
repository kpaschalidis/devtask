import { describe, expect, it } from "vitest";
import type { DevtaskConfig } from "../src/config.js";
import type { TaskReview } from "../src/task-inspection.js";
import { recommendNextAction } from "../src/workflow.js";

const config: DevtaskConfig = {
  schemaVersion: 1,
  codex: {
    model: null,
    fullAuto: true
  },
  runtime: {
    mode: "plain",
    backend: null
  },
  runtimeConfigured: true,
  verify: ["npm test"]
};

describe("workflow recommendations", () => {
  it("plans new tasks", () => {
    expect(recommendNextAction(taskReview({ status: "created" }), config)).toMatchObject({
      kind: "plan",
      command: "devtask plan example",
      automatic: true
    });
  });

  it("runs planned tasks", () => {
    expect(recommendNextAction(taskReview({ status: "planned" }), config)).toMatchObject({
      kind: "run",
      command: "devtask run example",
      automatic: true
    });
  });

  it("checks review tasks before review agent", () => {
    expect(recommendNextAction(taskReview({ status: "review" }), config)).toMatchObject({
      kind: "check",
      command: "devtask check example",
      automatic: true
    });
  });

  it("stops at human approval after fresh passing check and review", () => {
    expect(
      recommendNextAction(
        taskReview({
          status: "review",
          latestVerification: {
            status: "passed",
            finishedAt: "2026-05-05T00:00:01.000Z"
          },
          latestReviewAgent: {
            status: "passed",
            finishedAt: "2026-05-05T00:00:02.000Z"
          }
        }),
        config
      )
    ).toMatchObject({
      kind: "approve",
      command: "devtask approve example",
      automatic: false
    });
  });

  it("opens PRs only after approval", () => {
    expect(recommendNextAction(taskReview({ status: "approved" }), config)).toMatchObject({
      kind: "pr",
      command: "devtask pr example",
      automatic: true
    });
  });
});

function taskReview(options: {
  status: TaskReview["meta"]["status"];
  latestVerification?: { status: "passed" | "failed"; finishedAt: string };
  latestReviewAgent?: { status: "passed" | "findings" | "failed"; finishedAt: string };
}): TaskReview {
  return {
    meta: {
      schemaVersion: 1,
      id: "example",
      status: options.status,
      branch: "task/example",
      worktreePath: "/tmp/repo/.devtask/worktrees/example",
      taskPath: "/tmp/repo/.devtask/tasks/example/task.md",
      statePath: "/tmp/repo/.devtask/tasks/example/state.md",
      resultPath: "/tmp/repo/.devtask/tasks/example/result.json",
      model: null,
      command: "true",
      supervisorPid: null,
      childPid: null,
      tmuxSession: null,
      prUrl: null,
      failCount: 0,
      maxRetries: 5,
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z"
    },
    changedFiles: [],
    latestRun: null,
    latestVerification: options.latestVerification
      ? {
          schemaVersion: 1,
          verificationId: "check",
          taskId: "example",
          status: options.latestVerification.status,
          cwd: "/tmp/repo/.devtask/worktrees/example",
          startedAt: "2026-05-05T00:00:00.000Z",
          finishedAt: options.latestVerification.finishedAt,
          steps: []
        }
      : null,
    latestReviewAgent: options.latestReviewAgent
      ? {
          schemaVersion: 1,
          reviewId: "review",
          taskId: "example",
          status: options.latestReviewAgent.status,
          command: "codex exec",
          outputPath: "/tmp/repo/.devtask/tasks/example/reviews/review.md",
          startedAt: "2026-05-05T00:00:00.000Z",
          finishedAt: options.latestReviewAgent.finishedAt,
          exitCode: 0
        }
      : null,
    latestPlan: null,
    hasPlan: false,
    planPath: "/tmp/repo/.devtask/tasks/example/plan.md",
    result: null
  };
}
