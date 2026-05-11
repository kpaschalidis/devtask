import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { writeTaskMeta } from "../src/meta.js";
import { resolvePaths, resolveWorkspacePathsForInit, taskDir, taskMetaPath } from "../src/paths.js";
import { writeRunRecord } from "../src/run-record.js";
import { recordStage } from "../src/stage-contracts.js";
import { initializeWorkspace } from "../src/task-store.js";
import { approveWorkPlan, readWorkMaterialization } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import { createManualWorkItem } from "../src/work-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("work logs", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("defaults to the current workflow stage instead of artifact-latest", async () => {
    const { workspace } = await createWorkItemWithFailedCheck();
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-123", "--target", "backend"]);

    expect(output).toContain("backend/work-123-backend check");
    expect(output).toContain("Status: failed");
    expect(output).toContain("FAIL npm test");
    expect(output).not.toContain("backend/work-123-backend run");
  });

  it("keeps failed check step summaries visible when output is tailed", async () => {
    const { workspace } = await createWorkItemWithFailedCheck();
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-123", "--target", "backend", "--stage", "check", "-n", "1"]);

    expect(output).toContain("Steps:");
    expect(output).toContain("FAIL npm test");
    expect(output).toContain("last stderr line");
  });

  it("prints completed check output instead of failing when follow is requested for checks", async () => {
    const { workspace } = await createWorkItemWithFailedCheck();
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-123", "--target", "backend", "--stage", "check", "-f"]);

    expect(output).toContain("Check output is complete; printing the latest captured verification output instead of following.");
    expect(output).toContain("FAIL npm test");
  });
});

async function createWorkItemWithFailedCheck(): Promise<{ workspace: string }> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-logs-"));
  const repo = await makeTempRepo({ withCommit: true });
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  const item = createManualWorkItem(paths, {
    id: "WORK-123",
    title: "Implement work"
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
  await approveWorkPlan(paths, item);

  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    throw new Error("Expected work materialization");
  }
  const task = materialization.tasks[0];
  const repoPaths = resolvePaths(task.repoPath);
  const meta = JSON.parse(fs.readFileSync(taskMetaPath(repoPaths, task.taskId), "utf8"));
  writeTaskMeta(taskMetaPath(repoPaths, task.taskId), {
    ...meta,
    status: "done",
    updatedAt: "2026-05-11T10:00:00.000Z"
  });

  recordStage(repoPaths, task.taskId, "run", {
    status: "passed",
    startedAt: "2026-05-11T10:00:00.000Z",
    finishedAt: "2026-05-11T10:01:00.000Z"
  });
  recordStage(repoPaths, task.taskId, "check", {
    status: "failed",
    startedAt: "2026-05-11T10:02:00.000Z",
    finishedAt: "2026-05-11T10:03:00.000Z",
    reason: "one or more check commands failed"
  });

  const logsDir = path.join(taskDir(repoPaths, task.taskId), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const runLogPath = path.join(logsDir, "later-run.log");
  fs.writeFileSync(runLogPath, "run log\n");
  writeRunRecord(path.join(taskDir(repoPaths, task.taskId), "runs"), {
    schemaVersion: 1,
    runId: "2026-05-11T10-04-00-000Z",
    taskId: task.taskId,
    status: "success",
    command: "codex exec",
    cwd: task.worktreePath,
    logPath: runLogPath,
    startedAt: "2026-05-11T10:04:00.000Z",
    finishedAt: "2026-05-11T10:05:00.000Z",
    exitCode: 0
  });

  const verificationsDir = path.join(taskDir(repoPaths, task.taskId), "verifications");
  fs.mkdirSync(verificationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(verificationsDir, "2026-05-11T10-03-00-000Z.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verificationId: "2026-05-11T10-03-00-000Z",
        taskId: task.taskId,
        status: "failed",
        cwd: task.worktreePath,
        startedAt: "2026-05-11T10:02:00.000Z",
        finishedAt: "2026-05-11T10:03:00.000Z",
        steps: [
          {
            command: "npm test",
            exitCode: 1,
            stdout: "first stdout line\nlast stdout line\n",
            stderr: "first stderr line\nlast stderr line\n"
          }
        ]
      },
      null,
      2
    )}\n`
  );

  return { workspace };
}

async function runCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  await createCli().parseAsync(["node", "devtask", ...args], { from: "node" });
  return lines.join("\n");
}
