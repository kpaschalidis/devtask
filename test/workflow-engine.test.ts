import { describe, expect, it } from "vitest";
import { DEFAULT_DEV_WORKFLOW, runWorkflowStage, workflowStageFailed, type WorkflowUnit } from "../src/workflow-engine.js";

const units: WorkflowUnit[] = [
  {
    target: "backend",
    taskId: "backend-task",
    repoPath: "/tmp/backend"
  },
  {
    target: "frontend",
    taskId: "frontend-task",
    repoPath: "/tmp/frontend"
  }
];

describe("workflow engine", () => {
  it("defines the full default dev workflow lifecycle", () => {
    expect(DEFAULT_DEV_WORKFLOW.stages.map((stage) => stage.id)).toEqual([
      "plan",
      "run",
      "check",
      "fix",
      "review",
      "approve",
      "commit",
      "pr",
      "ci"
    ]);
  });

  it("runs parallel stages for all units", async () => {
    const result = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, units, {
      stage: "check",
      run: async (unit) => ({
        status: "passed",
        detail: unit.taskId
      })
    });

    expect(result).toMatchObject({
      workflowId: "default-dev",
      stage: "check",
      results: [
        {
          unit: units[0],
          status: "passed",
          detail: "backend-task"
        },
        {
          unit: units[1],
          status: "passed",
          detail: "frontend-task"
        }
      ]
    });
    expect(workflowStageFailed(result)).toBe(false);
  });

  it("captures per-unit failures without aborting the whole stage", async () => {
    const result = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, units, {
      stage: "review",
      run: async (unit) => {
        if (unit.target === "frontend") {
          throw new Error("review failed");
        }
        return {
          status: "passed",
          detail: "ok"
        };
      }
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        unit: units[0],
        status: "passed"
      }),
      expect.objectContaining({
        unit: units[1],
        status: "failed",
        detail: "review failed"
      })
    ]);
    expect(workflowStageFailed(result)).toBe(true);
  });
});
