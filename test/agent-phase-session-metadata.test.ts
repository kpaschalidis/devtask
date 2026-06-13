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
          provider: "codex",
          transportId: `session-${phaseLabel}`,
          resumeContext: {
            providerSessionId: `agent-${phaseLabel}`,
            conversationId: `thread-${phaseLabel}`,
            resumeTarget: `agent-${phaseLabel}`,
            storageRoot: `/tmp/codex-home-${phaseLabel}`,
            transcriptPath: `/tmp/codex-home-${phaseLabel}/sessions/${phaseLabel}.jsonl`
          },
          summary: `${phaseLabel} complete`,
          summaryIsFallback: false
        }
      };
    })
  };
});

import { getLatestWorkPhaseRun } from "../src/services/phase-run-service.js";
import { listWorkAgentSessions } from "../src/services/agent-session-registry-service.js";
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
    const sessionEntries = listWorkAgentSessions(paths, item.id, { latest: true });

    expect(specRun?.session.resumeContext.storageRoot).toBe("/tmp/codex-home-spec");
    expect(specRun?.session.resumeContext.transcriptPath).toBe("/tmp/codex-home-spec/sessions/spec.jsonl");
    expect(planRun?.session.resumeContext.storageRoot).toBe("/tmp/codex-home-plan");
    expect(planRun?.session.resumeContext.transcriptPath).toBe("/tmp/codex-home-plan/sessions/plan.jsonl");
    expect(repoPlanRun?.session.resumeContext.storageRoot).toBe("/tmp/codex-home-repo-plan");
    expect(repoPlanRun?.session.resumeContext.transcriptPath).toBe("/tmp/codex-home-repo-plan/sessions/repo-plan.jsonl");
    expect(reviewRun?.session.resumeContext.storageRoot).toBe("/tmp/codex-home-review");
    expect(reviewRun?.session.resumeContext.transcriptPath).toBe("/tmp/codex-home-review/sessions/review.jsonl");

    expect(specRun?.session.resumeContext.conversationId).toBe("thread-spec");
    expect(planRun?.session.resumeContext.conversationId).toBe("thread-plan");
    expect(repoPlanRun?.session.resumeContext.conversationId).toBe("thread-repo-plan");
    expect(reviewRun?.session.resumeContext.conversationId).toBe("thread-review");
    expect(sessionEntries).toHaveLength(4);
    expect(sessionEntries.find((entry) => entry.phase === "repo-plan")?.session.resumeContext.resumeTarget).toBe("agent-repo-plan");
  });
});
