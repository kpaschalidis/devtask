import { describe, expect, it } from "vitest";
import type { DevtaskConfig } from "../src/config.js";
import type { TaskReview } from "../src/task-inspection.js";
import { buildBoardRow, recommendNextAction } from "../src/workflow.js";

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

  it("retries planning when the planning stage failed", () => {
    expect(
      recommendNextAction(
        taskReview({
          status: "failed",
          stages: {
            plan: {
              stage: "plan",
              status: "failed",
              startedAt: "2026-05-05T00:00:00.000Z",
              finishedAt: "2026-05-05T00:00:01.000Z",
              input: {},
              output: {},
              artifacts: [],
              reason: "planning failed"
            }
          }
        }),
        config
      )
    ).toMatchObject({
      kind: "plan",
      command: "devtask plan example",
      automatic: false
    });
  });

  it("checks review tasks before review agent", () => {
    expect(recommendNextAction(taskReview({ status: "review" }), config)).toMatchObject({
      kind: "check",
      command: "devtask check example",
      automatic: true
    });
  });

  it("routes failed checks to the fix stage", () => {
    const review = taskReview({
      status: "review",
      latestVerification: {
        status: "failed",
        finishedAt: "2026-05-05T00:00:01.000Z"
      },
      stages: {
        check: {
          stage: "check",
          status: "failed",
          startedAt: "2026-05-05T00:00:00.000Z",
          finishedAt: "2026-05-05T00:00:01.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: "checks failed"
        }
      }
    });

    expect(recommendNextAction(review, config)).toMatchObject({
      kind: "fix",
      command: "devtask fix example --from check",
      automatic: false
    });
    expect(buildBoardRow(review, config)).toMatchObject({
      stage: "fix",
      status: "ready",
      next: "devtask fix example --from check"
    });
  });

  it("routes stale failed checks back to check after a fix changed the task", () => {
    const review = taskReview({
      status: "done",
      updatedAt: "2026-05-05T00:00:03.000Z",
      latestVerification: {
        status: "failed",
        finishedAt: "2026-05-05T00:00:01.000Z"
      },
      stages: {
        run: {
          stage: "run",
          status: "passed",
          startedAt: "2026-05-05T00:00:00.000Z",
          finishedAt: "2026-05-05T00:00:03.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        },
        fix: {
          stage: "fix",
          status: "passed",
          startedAt: "2026-05-05T00:00:02.000Z",
          finishedAt: "2026-05-05T00:00:03.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        }
      }
    });

    expect(buildBoardRow(review, config)).toMatchObject({
      stage: "check",
      status: "pending",
      check: "failed:stale",
      next: "devtask check example"
    });
  });

  it("checks run-complete tasks before treating them as terminal", () => {
    expect(
      recommendNextAction(
        taskReview({
          status: "done",
          stages: {
            run: {
              stage: "run",
              status: "passed",
              startedAt: "2026-05-05T00:00:00.000Z",
              finishedAt: "2026-05-05T00:00:01.000Z",
              input: {},
              output: {},
              artifacts: [],
              reason: null
            }
          }
        }),
        config
      )
    ).toMatchObject({
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

  it("does not make checks stale after metadata-only approval", () => {
    const review = taskReview({
      status: "approved",
      updatedAt: "2026-05-05T00:00:05.000Z",
      latestVerification: {
        status: "passed",
        finishedAt: "2026-05-05T00:00:02.000Z"
      },
      latestReviewAgent: {
        status: "passed",
        finishedAt: "2026-05-05T00:00:03.000Z"
      },
      stages: {
        run: {
          stage: "run",
          status: "passed",
          startedAt: "2026-05-05T00:00:00.000Z",
          finishedAt: "2026-05-05T00:00:01.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        },
        check: {
          stage: "check",
          status: "passed",
          startedAt: "2026-05-05T00:00:01.000Z",
          finishedAt: "2026-05-05T00:00:02.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        },
        review: {
          stage: "review",
          status: "passed",
          startedAt: "2026-05-05T00:00:02.000Z",
          finishedAt: "2026-05-05T00:00:03.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        },
        approve: {
          stage: "approve",
          status: "passed",
          startedAt: "2026-05-05T00:00:04.000Z",
          finishedAt: "2026-05-05T00:00:05.000Z",
          input: {},
          output: {},
          artifacts: [],
          reason: null
        }
      }
    });

    expect(buildBoardRow(review, config)).toMatchObject({
      stage: "pr",
      status: "pending",
      check: "passed",
      review: "passed",
      next: "devtask pr example"
    });
  });

  it("can recommend approval from stage contract state", () => {
    const review = taskReview({ status: "review" });
    review.stages.stages.check = {
      stage: "check",
      status: "passed",
      startedAt: "2026-05-05T00:00:00.000Z",
      finishedAt: "2026-05-05T00:00:01.000Z",
      input: {},
      output: {},
      artifacts: [],
      reason: null
    };
    review.stages.stages.review = {
      stage: "review",
      status: "passed",
      startedAt: "2026-05-05T00:00:01.000Z",
      finishedAt: "2026-05-05T00:00:02.000Z",
      input: {},
      output: {},
      artifacts: [],
      reason: null
    };

    expect(recommendNextAction(review, config)).toMatchObject({
      kind: "approve",
      command: "devtask approve example",
      automatic: false
    });
  });

  it("builds board rows with lifecycle stage and stage status", () => {
    const row = buildBoardRow(
      taskReview({
        status: "failed",
        stages: {
          plan: {
            stage: "plan",
            status: "failed",
            startedAt: "2026-05-05T00:00:00.000Z",
            finishedAt: "2026-05-05T00:00:01.000Z",
            input: {},
            output: {},
            artifacts: [],
            reason: "planning failed"
          }
        }
      }),
      config
    );

    expect(row).toMatchObject({
      stage: "plan",
      status: "failed",
      next: "devtask plan example"
    });
  });
});

function taskReview(options: {
  status: TaskReview["meta"]["status"];
  updatedAt?: string;
  latestVerification?: { status: "passed" | "failed"; finishedAt: string };
  latestReviewAgent?: { status: "passed" | "findings" | "failed"; finishedAt: string };
  stages?: TaskReview["stages"]["stages"];
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
      updatedAt: options.updatedAt ?? "2026-05-05T00:00:00.000Z"
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
    stages: {
      schemaVersion: 1,
      taskId: "example",
      updatedAt: "1970-01-01T00:00:00.000Z",
      stages: options.stages ?? {}
    },
    hasPlan: false,
    planPath: "/tmp/repo/.devtask/tasks/example/plan.md",
    result: null
  };
}
