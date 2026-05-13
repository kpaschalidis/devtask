import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandOrThrow } from "../src/process-runner.js";
import { resolvePaths, resolveWorkspacePathsForInit } from "../src/paths.js";
import { recordStage } from "../src/stage-contracts.js";
import { initializeWorkspace } from "../src/task-store.js";
import { approveWorkPlan } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import {
  buildWorkExecReviewPacket,
  buildWorkSpecReviewPacket,
  formatWorkExecReviewPacket,
  formatWorkSpecReviewPacket
} from "../src/work-review-packets.js";
import { createManualWorkItem } from "../src/work-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("work review packets", () => {
  it("summarizes spec artifacts and repo-plan readiness", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-review-spec-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: ["npm test"],
          openQuestions: []
        },
        null,
        2
      )
    );
    await approveWorkPlan(paths, item);

    const packet = await buildWorkSpecReviewPacket(paths, item);

    expect(packet).toMatchObject({
      workId: "WORK-123",
      planExists: true,
      graphExists: true,
      approvedGraphExists: true,
      materialized: true,
      validation: ["npm test"],
      tasks: [
        expect.objectContaining({
          id: "work-123-backend",
          target: "backend",
          targetExists: true,
          materializedTaskId: "work-123-backend",
          repoPlanExists: false
        })
      ]
    });
    expect(packet.messages.map((message) => message.message)).toContain("backend/work-123-backend is missing a repo plan");
    expect(formatWorkSpecReviewPacket(packet)).toContain("Review spec for WORK-123");
  });

  it("summarizes committed execution state and dirty files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-review-exec-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceTarget(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(workPlanPath(paths, item.id), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              target: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );
    const materialization = await approveWorkPlan(paths, item);
    const task = materialization.tasks[0]!;
    const repoPaths = resolvePaths(task.repoPath);
    fs.writeFileSync(path.join(task.worktreePath, "feature.txt"), "implemented\n");
    await runCommandOrThrow("git", ["add", "feature.txt"], { cwd: task.worktreePath });
    await runCommandOrThrow("git", ["commit", "-m", "implement feature"], { cwd: task.worktreePath });
    fs.writeFileSync(path.join(task.worktreePath, "local-note.md"), "manual note\n");
    recordStage(repoPaths, task.taskId, "check", { status: "passed" });
    recordStage(repoPaths, task.taskId, "review", { status: "passed" });

    const packet = await buildWorkExecReviewPacket(paths, item);

    expect(packet.tasks).toEqual([
      expect.objectContaining({
        target: "backend",
        taskId: "work-123-backend",
        commitsAhead: 1,
        committedChangedFiles: ["A\tfeature.txt"],
        untrackedFiles: ["local-note.md"],
        checkStatus: "passed",
        agentReviewStatus: "passed"
      })
    ]);
    expect(packet.messages.map((message) => message.message)).toContain(
      "backend/work-123-backend has untracked files not included in commits"
    );
    expect(formatWorkExecReviewPacket(packet)).toContain("Review execution for WORK-123");
  });
});
