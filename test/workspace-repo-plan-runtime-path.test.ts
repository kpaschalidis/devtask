import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const capturedPlanPaths: string[] = [];
const capturedResultPaths: string[] = [];

vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  return {
    ...actual,
    createDefaultAgentRunner: vi.fn(() => ({
      buildStartCommand: () => "fake-agent"
    })),
    runAgentPrompt: vi.fn(async (_runner, startOptions: { env?: Record<string, string> }) => {
      const planPath = startOptions.env?.DEVTASK_PLAN_PATH;
      const resultPath = startOptions.env?.DEVTASK_RESULT_PATH;
      if (!planPath || !resultPath) {
        throw new Error("missing runtime plan/result path");
      }

      capturedPlanPaths.push(planPath);
      capturedResultPaths.push(resultPath);
      fs.writeFileSync(planPath, "# Repo Plan\n\nGenerated repo plan.\n");
      fs.writeFileSync(resultPath, JSON.stringify({ status: "planned" }, null, 2));

      return {
        status: "completed",
        error: null,
        session: {
          transportSessionId: "session-1",
          threadId: "thread-1",
          agentSessionId: "agent-1",
          summary: "planned",
          summaryIsFallback: false,
          homePath: "/tmp/codex-home-repo-plan",
          sessionFilePath: "/tmp/codex-home-repo-plan/sessions/repo-plan.jsonl"
        }
      };
    })
  };
});

import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { repoPlanWork } from "../src/services/work-service.js";
import { workGraphPath } from "../src/global-plan.js";
import { makeTempRepo } from "./helpers.js";

describe("workspace repo-plan runtime path", () => {
  it("uses repo-local temporary plan/result paths and cleans them up after persistence", async () => {
    capturedPlanPaths.length = 0;
    capturedResultPaths.length = 0;

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-repo-plan-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });

    const item = createManualWorkItem(paths, {
      id: "WORK-REPO-PATH",
      title: "Use repo-local runtime plan paths"
    });

    fs.writeFileSync(path.join(paths.workDir, item.id, "spec.md"), "# Spec\n");
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(paths.localDir, "work", item.id, "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "plans", "latest.json"),
      `${JSON.stringify({ schemaVersion: 1, phase: "plan", planId: "latest", workId: item.id, status: "planned", command: "fake", promptPath: "p", outputPath: "o", planPath: "p", graphPath: "g", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", exitCode: 0, session: { transportSessionId: null, threadId: null, agentSessionId: null, summary: null, summaryIsFallback: null, homePath: null, sessionFilePath: null } }, null, 2)}\n`
    );
    fs.writeFileSync(
      workGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "task-backend",
              repoId: "backend",
              goal: "Plan backend work.",
              owns: ["src/**"],
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

    const result = await repoPlanWork(paths, item.id, { refresh: true });

    expect(result.repoPlans).toHaveLength(1);
    expect(result.repoPlans[0]?.status).toBe("planned");
    expect(capturedPlanPaths).toHaveLength(1);
    expect(capturedResultPaths).toHaveLength(1);
    const repoRealPath = fs.realpathSync.native(repo);
    const capturedPlanRealPath = fs.realpathSync.native(path.dirname(capturedPlanPaths[0]!));
    const capturedResultRealPath = fs.realpathSync.native(path.dirname(capturedResultPaths[0]!));
    expect(capturedPlanPaths[0], `plan path: ${capturedPlanPaths[0]}`).toBeDefined();
    expect(capturedResultPaths[0], `result path: ${capturedResultPaths[0]}`).toBeDefined();
    expect(capturedPlanRealPath.startsWith(repoRealPath), `plan path: ${capturedPlanPaths[0]}`).toBe(true);
    expect(capturedResultRealPath.startsWith(repoRealPath), `result path: ${capturedResultPaths[0]}`).toBe(true);
    expect(path.relative(repoRealPath, capturedPlanRealPath).startsWith("..")).toBe(false);
    expect(path.relative(repoRealPath, capturedResultRealPath).startsWith("..")).toBe(false);
    expect(fs.existsSync(capturedPlanPaths[0]!)).toBe(false);
    expect(fs.existsSync(capturedResultPaths[0]!)).toBe(false);
    expect(fs.existsSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"))).toBe(true);
  });
});
