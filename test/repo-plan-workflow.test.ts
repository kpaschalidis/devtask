import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  return {
    ...actual,
    createDefaultAgentRunner: vi.fn(() => ({
      buildStartCommand: () => "fake-agent"
    })),
    runAgentPrompt: vi.fn(async (_runner, startOptions: { env?: Record<string, string> }) => {
      const planPath = startOptions.env?.DEVTASK_PLAN_PATH;
      if (planPath) {
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, "# Repo Plan\n\nDo the repo work.\n");
      }
      return {
        status: "completed",
        error: null,
        session: {
          transportSessionId: "session-1",
          threadId: "thread-1",
          agentSessionId: "agent-1",
          summary: "planned",
          summaryIsFallback: false
        }
      };
    })
  };
});

import { resolveWorkspacePathsForInit, taskMetaPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { repoPlanWork } from "../src/services/work-service.js";
import { materializeWorkPlan } from "../src/work-materializer.js";
import { workGraphPath } from "../src/global-plan.js";
import { readTaskMeta } from "../src/storage/meta.js";
import { getWorkItem } from "../src/storage/work-store.js";
import { makeTempRepo } from "./helpers.js";

describe("repo-plan workflow", () => {
  it("writes repo plans before materialization and lets materialize hydrate task plans", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-repo-plan-workflow-"));
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
    fs.mkdirSync(path.join(paths.localDir, "work", item.id, "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "plans", "latest.json"),
      `${JSON.stringify({ schemaVersion: 1, phase: "plan", planId: "latest", workId: item.id, status: "planned", command: "fake", promptPath: "p", outputPath: "o", planPath: "p", graphPath: "g", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", exitCode: 0, session: { transportSessionId: null, threadId: null, agentSessionId: null, summary: null, summaryIsFallback: null } }, null, 2)}\n`
    );
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

    const repoPlan = await repoPlanWork(paths, item.id);

    expect(repoPlan.materialized).toBe(false);
    expect(getWorkItem(paths, item.id).status).toBe("planned");
    expect(fs.existsSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"))).toBe(true);
    expect(fs.existsSync(path.join(paths.tasksDir, "work-123-backend", "meta.json"))).toBe(false);

    await materializeWorkPlan(paths, item);

    expect(getWorkItem(paths, item.id).status).toBe("planned");
    const meta = readTaskMeta(taskMetaPath(paths, "work-123-backend"));
    expect(meta.status).toBe("ready");
    expect(fs.existsSync(path.join(paths.tasksDir, "work-123-backend", "plan.md"))).toBe(true);
  });
});
