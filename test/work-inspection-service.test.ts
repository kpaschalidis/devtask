import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, taskMetaPath, workItemRepoPhaseRunsDir } from "../src/infra/paths.js";
import { writePhaseRunRecord } from "../src/infra/phase-run.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan } from "../src/work-materializer.js";
import { workGraphPath } from "../src/global-plan.js";
import { readTaskMeta, writeTaskMeta } from "../src/storage/meta.js";
import { inspectWork } from "../src/services/work-inspection-service.js";
import { makeTempRepo } from "./helpers.js";

describe("work inspection service", () => {
  it("gathers artifacts, latest phase runs, and problem tasks for one work item", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-inspection-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "spec.md"), "# Spec\n");
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
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
    await materializeWorkPlan(paths, item);

    const metaPath = taskMetaPath(paths, "work-123-backend");
    const initial = readTaskMeta(metaPath);
    writeTaskMeta(metaPath, {
      ...initial,
      status: "blocked",
      tmuxSession: "devtask-backend",
      resultSummary: "waiting for API contract",
      runtime: {
        state: "completed",
        reason: "waiting for API contract",
        lastObservedAt: "2026-01-01T00:00:10.000Z"
      },
      updatedAt: "2026-01-01T00:00:11.000Z"
    });
    writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, item.id, "execute", "backend"), {
      schemaVersion: 1,
      phase: "execute",
      runId: "2026-01-01T00-00-01-000Z",
      workId: item.id,
      repoId: "backend",
      taskId: "work-123-backend",
      status: "blocked",
      promptPath: "/tmp/execute.prompt.md",
      outputPath: "/tmp/execute.output.md",
      startedAt: "2026-01-01T00:00:09.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      session: {
        provider: "codex",
        transportId: "devtask-backend",
        providerSessionId: "agent-123",
        conversationId: "thread-123",
        resumeTarget: "agent-123",
        summary: "waiting for API contract",
        summaryIsFallback: false,
        storageRoot: null,
        transcriptPath: null
      },
      artifacts: {
        resultPath: "/tmp/result.json"
      },
      exitCode: null
    });

    const inspection = inspectWork(paths, item.id);

    expect(inspection.artifacts.find((artifact) => artifact.label === "spec")?.exists).toBe(true);
    expect(inspection.latestPhaseRuns[0]).toMatchObject({
      phase: "execute",
      repoId: "backend",
      status: "blocked",
      promptPath: "/tmp/execute.prompt.md",
      provider: "codex",
      transportId: "devtask-backend",
      conversationId: "thread-123",
      providerSessionId: "agent-123",
      transcriptPath: null,
      artifacts: {
        resultPath: "/tmp/result.json"
      }
    });
    expect(inspection.problemTasks).toEqual([
      expect.objectContaining({
        repoId: "backend",
        taskId: "work-123-backend",
        status: "blocked",
        reason: "waiting for API contract",
        sessionName: "devtask-backend"
      })
    ]);
  });
});
