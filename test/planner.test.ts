import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlanPromptForTest, hasTaskPlan, readLatestPlan } from "../src/repo-plan.js";
import { resolvePaths, planMarkdownPath } from "../src/infra/paths.js";
import { createTask } from "../src/storage/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("planner artifacts", () => {
  it("detects task plans and reads the latest plan record", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "planned-task");
    const plansDir = path.join(repo, ".devtask", "tasks", meta.id, "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    expect(hasTaskPlan(paths, meta.id)).toBe(false);
    fs.writeFileSync(planMarkdownPath(paths, meta.id), "# Plan\n\nDo the work.\n");
    expect(hasTaskPlan(paths, meta.id)).toBe(true);

    const record = {
      schemaVersion: 1,
      phase: "repo-plan",
      planId: "2026-01-01T00-00-00-000Z",
      taskId: meta.id,
      status: "planned",
      command: "codex exec",
      promptPath: path.join(plansDir, "2026-01-01T00-00-00-000Z.prompt.md"),
      outputPath: path.join(plansDir, "2026-01-01T00-00-00-000Z.md"),
      planPath: planMarkdownPath(paths, meta.id),
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0,
      worktreeChanged: false,
      session: {
        transportSessionId: "session-1",
        threadId: "thread-1",
        agentSessionId: "agent-session-1",
        summary: "planned successfully",
        summaryIsFallback: false
      }
    };
    fs.writeFileSync(path.join(plansDir, `${record.planId}.json`), `${JSON.stringify(record, null, 2)}\n`);

    expect(readLatestPlan(paths, meta.id)?.status).toBe("planned");
  });

  it("builds a research-first planning prompt with explicit artifact boundaries", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "prompt-task", {
      goal: "Add health-check endpoint"
    });

    const writablePlanPath = path.join(meta.worktreePath, ".devtask_plan.md");
    const finalPlanPath = planMarkdownPath(paths, meta.id);
    const prompt = buildPlanPromptForTest(meta, writablePlanPath, finalPlanPath);

    expect(prompt).toContain("You are in the devtask planning stage.");
    expect(prompt).toContain("The only file you may write is this worktree-local devtask plan artifact");
    expect(prompt).toContain(writablePlanPath);
    expect(prompt).not.toContain(finalPlanPath);
    expect(prompt).toContain("Devtask will persist that plan after the run.");
    expect(prompt).toContain("Do not update task state during planning");
    expect(prompt).toContain("Before writing the plan:");
    expect(prompt).toContain("Relevant Existing Files");
    expect(prompt).toContain("Current Behavior / Current Structure");
    expect(prompt).toContain("Step-by-Step Implementation Plan");
    expect(prompt).toContain("Every implementation step must name the expected files");
    expect(prompt).toContain("Do not invent requirements");
    expect(prompt).toContain("Add health-check endpoint");
  });
});
