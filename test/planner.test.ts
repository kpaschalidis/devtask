import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasTaskPlan, readLatestPlan } from "../src/planner.js";
import { resolvePaths, planMarkdownPath } from "../src/paths.js";
import { createTask } from "../src/task-store.js";
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
      worktreeChanged: false
    };
    fs.writeFileSync(path.join(plansDir, `${record.planId}.json`), `${JSON.stringify(record, null, 2)}\n`);

    expect(readLatestPlan(paths, meta.id)?.status).toBe("planned");
  });
});
