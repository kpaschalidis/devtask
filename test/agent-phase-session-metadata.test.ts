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
      const env = startOptions.env ?? {};

      if (env.DEVTASK_WORK_SPEC_PATH) {
        fs.mkdirSync(path.dirname(env.DEVTASK_WORK_SPEC_PATH), { recursive: true });
        fs.writeFileSync(env.DEVTASK_WORK_SPEC_PATH, "# Spec\n\nGenerated spec.\n");
      }

      if (env.DEVTASK_WORK_PLAN_PATH && env.DEVTASK_WORK_GRAPH_PATH) {
        fs.mkdirSync(path.dirname(env.DEVTASK_WORK_PLAN_PATH), { recursive: true });
        fs.writeFileSync(env.DEVTASK_WORK_PLAN_PATH, "# Plan\n\nGenerated plan.\n");
        fs.writeFileSync(
          env.DEVTASK_WORK_GRAPH_PATH,
          JSON.stringify(
            {
              schemaVersion: 1,
              workId: "WORK-ISO",
              tasks: [
                {
                  id: "work-iso-backend",
                  repoId: "backend",
                  goal: "Implement the backend change.",
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
      }

      if (env.DEVTASK_PLAN_PATH) {
        fs.mkdirSync(path.dirname(env.DEVTASK_PLAN_PATH), { recursive: true });
        fs.writeFileSync(env.DEVTASK_PLAN_PATH, "# Repo Plan\n\nGenerated repo plan.\n");
      }

      if (env.DEVTASK_REVIEW_PATH && env.DEVTASK_REVIEW_RESULT_PATH) {
        fs.mkdirSync(path.dirname(env.DEVTASK_REVIEW_PATH), { recursive: true });
        fs.writeFileSync(env.DEVTASK_REVIEW_PATH, "# Review\n\nLooks good.\n");
        fs.writeFileSync(
          env.DEVTASK_REVIEW_RESULT_PATH,
          JSON.stringify(
            {
              status: "approved",
              summary: "approved in test",
              findings: []
            },
            null,
            2
          )
        );
      }

      const phaseLabel =
        env.DEVTASK_WORK_SPEC_PATH ? "spec" :
        env.DEVTASK_WORK_PLAN_PATH ? "plan" :
        env.DEVTASK_PLAN_PATH ? "repo-plan" :
        env.DEVTASK_REVIEW_PATH ? "review" :
        "unknown";

      return {
        status: "completed",
        error: null,
        session: {
          transportSessionId: `session-${phaseLabel}`,
          threadId: `thread-${phaseLabel}`,
          agentSessionId: `agent-${phaseLabel}`,
          summary: `${phaseLabel} complete`,
          summaryIsFallback: false,
          homePath: `/tmp/codex-home-${phaseLabel}`,
          sessionFilePath: `/tmp/codex-home-${phaseLabel}/sessions/${phaseLabel}.jsonl`
        }
      };
    })
  };
});

import { getLatestWorkPhaseRun } from "../src/services/phase-run-service.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem, getWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan } from "../src/work-materializer.js";
import { planWork, repoPlanWork, reviewWork, specWork } from "../src/services/work-service.js";
import { makeTempRepo } from "./helpers.js";

describe("agent phase session metadata", () => {
  it("persists isolated session metadata across spec, plan, repo-plan, and review phase runs", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-agent-phase-metadata-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });

    const item = createManualWorkItem(paths, {
      id: "WORK-ISO",
      title: "Persist isolated session metadata",
      body: "Exercise agent-backed phases."
    });

    const specResult = await specWork(paths, item.id);
    expect(specResult.status).toBe("spec-ready");

    const planResult = await planWork(paths, item.id);
    expect(planResult.status).toBe("planned");

    const repoPlanResult = await repoPlanWork(paths, item.id);
    expect(repoPlanResult.repoPlans).toHaveLength(1);
    expect(repoPlanResult.repoPlans[0]?.status).toBe("planned");

    await materializeWorkPlan(paths, getWorkItem(paths, item.id));

    const reviewResult = await reviewWork(paths, item.id);
    expect(reviewResult.tasks).toHaveLength(1);
    expect(reviewResult.tasks[0]?.status).toBe("approved");

    const specRun = getLatestWorkPhaseRun(paths, item.id, "spec");
    const planRun = getLatestWorkPhaseRun(paths, item.id, "plan");
    const repoPlanRun = getLatestWorkPhaseRun(paths, item.id, "repo-plan", "backend");
    const reviewRun = getLatestWorkPhaseRun(paths, item.id, "review", "backend");

    expect(specRun?.session.homePath).toBe("/tmp/codex-home-spec");
    expect(specRun?.session.sessionFilePath).toBe("/tmp/codex-home-spec/sessions/spec.jsonl");
    expect(planRun?.session.homePath).toBe("/tmp/codex-home-plan");
    expect(planRun?.session.sessionFilePath).toBe("/tmp/codex-home-plan/sessions/plan.jsonl");
    expect(repoPlanRun?.session.homePath).toBe("/tmp/codex-home-repo-plan");
    expect(repoPlanRun?.session.sessionFilePath).toBe("/tmp/codex-home-repo-plan/sessions/repo-plan.jsonl");
    expect(reviewRun?.session.homePath).toBe("/tmp/codex-home-review");
    expect(reviewRun?.session.sessionFilePath).toBe("/tmp/codex-home-review/sessions/review.jsonl");

    expect(specRun?.session.threadId).toBe("thread-spec");
    expect(planRun?.session.threadId).toBe("thread-plan");
    expect(repoPlanRun?.session.threadId).toBe("thread-repo-plan");
    expect(reviewRun?.session.threadId).toBe("thread-review");
  });
});
