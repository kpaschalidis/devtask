import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/errors.js";
import { assertCanMark, parseManualStatus } from "../src/lifecycle.js";
import type { TaskMeta } from "../src/types.js";

function meta(status: TaskMeta["status"]): TaskMeta {
  return {
    schemaVersion: 1,
    id: "task",
    status,
    branch: "task/task",
    worktreePath: "/tmp/worktree",
    taskPath: "/tmp/task.md",
    statePath: "/tmp/state.md",
    resultPath: "/tmp/result.json",
    model: null,
    command: "true",
    supervisorPid: null,
    childPid: null,
    tmuxSession: null,
    failCount: 0,
    maxRetries: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("lifecycle", () => {
  it("parses manual statuses", () => {
    expect(parseManualStatus("review")).toBe("review");
    expect(parseManualStatus("done")).toBe("done");
    expect(() => parseManualStatus("running")).toThrow(DevtaskError);
  });

  it("prevents marking running tasks", () => {
    expect(() => assertCanMark(meta("running"), "review")).toThrow(DevtaskError);
  });

  it("allows stopped tasks to be marked for review", () => {
    expect(() => assertCanMark(meta("cancelled"), "review")).not.toThrow();
  });
});
