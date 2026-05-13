import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { readConfig, writeConfig } from "../src/config.js";
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

  it("treats fix as a first-class log stage", async () => {
    const { workspace } = await createWorkItemWithFailedCheck();
    addFixLog(workspace);
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-123", "--target", "backend", "--stage", "fix"]);

    expect(output).toContain("backend/work-123-backend fix");
    expect(output).toContain("fix log");
  });

  it("prints raw run logs when the run record is missing", async () => {
    const { workspace } = await createWorkItemWithFailedCheck();
    removeRunRecords(workspace);
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-123", "--target", "backend", "--stage", "run"]);

    expect(output).toContain("backend/work-123-backend run");
    expect(output).toContain("run log");
  });

  it("shows workspace planning output before materialization", async () => {
    const { workspace } = createUnmaterializedWorkItemWithPlanOutput();
    process.chdir(workspace);
    const output = await runCli(["work", "logs", "WORK-PLAN"]);

    expect(output).toContain("Work WORK-PLAN plan");
    expect(output).toContain("planner output");
  });
});

describe("work target selection", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("limits work check to the selected target", async () => {
    const { workspace } = await createTwoTargetWorkItem();
    process.chdir(workspace);
    const output = await runCli(["work", "check", "WORK-123", "--target", "backend"]);

    expect(output).toContain("backend");
    expect(output).toContain("work-123-backend");
    expect(output).not.toContain("frontend");
    expect(output).not.toContain("work-123-frontend");
  });

  it("rejects unknown selected targets", async () => {
    const { workspace } = await createTwoTargetWorkItem();
    process.chdir(workspace);

    const output = await runCli(["work", "check", "WORK-123", "--target", "mobile"]);

    expect(output).toContain("devtask: Work item WORK-123 does not have target mobile");
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

function addFixLog(workspace: string): void {
  const paths = resolveWorkspacePathsForInit(workspace);
  const materialization = readWorkMaterialization(paths, "WORK-123");
  if (!materialization) {
    throw new Error("Expected work materialization");
  }
  const task = materialization.tasks[0];
  const repoPaths = resolvePaths(task.repoPath);
  const logsDir = path.join(taskDir(repoPaths, task.taskId), "logs");
  const fixLogPath = path.join(logsDir, "fix.log");
  fs.writeFileSync(fixLogPath, "fix log\n");
  recordStage(repoPaths, task.taskId, "fix", {
    status: "failed",
    startedAt: "2026-05-11T10:06:00.000Z",
    finishedAt: "2026-05-11T10:07:00.000Z",
    artifacts: [fixLogPath],
    reason: "worker command failed while applying fix"
  });
}

function removeRunRecords(workspace: string): void {
  const paths = resolveWorkspacePathsForInit(workspace);
  const materialization = readWorkMaterialization(paths, "WORK-123");
  if (!materialization) {
    throw new Error("Expected work materialization");
  }
  const task = materialization.tasks[0];
  const repoPaths = resolvePaths(task.repoPath);
  const runsDir = path.join(taskDir(repoPaths, task.taskId), "runs");
  for (const file of fs.readdirSync(runsDir)) {
    fs.unlinkSync(path.join(runsDir, file));
  }
}

function createUnmaterializedWorkItemWithPlanOutput(): { workspace: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-plan-logs-"));
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  createManualWorkItem(paths, {
    id: "WORK-PLAN",
    title: "Plan work"
  });
  const plansDir = path.join(workspace, ".devtask", "work", "WORK-PLAN", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, "2026-05-12T10-00-00-000Z.md"), "planner output\n");
  return { workspace };
}

async function createTwoTargetWorkItem(): Promise<{ workspace: string }> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-target-"));
  const backendRepo = await makeTempRepo({ withCommit: true });
  const frontendRepo = await makeTempRepo({ withCommit: true });
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  const item = createManualWorkItem(paths, {
    id: "WORK-123",
    title: "Implement work"
  });
  addWorkspaceTarget(paths, {
    id: "backend",
    repoPath: backendRepo,
    kind: "api"
  });
  addWorkspaceTarget(paths, {
    id: "frontend",
    repoPath: frontendRepo,
    kind: "web"
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
          },
          {
            id: "work-123-frontend",
            target: "frontend",
            goal: "Implement frontend behavior.",
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
  await approveWorkPlan(paths, item);
  for (const task of readWorkMaterialization(paths, item.id)?.tasks ?? []) {
    const repoPaths = resolvePaths(task.repoPath);
    writeConfig(repoPaths, {
      ...readConfig(repoPaths),
      verify: ["node -e \"process.exit(0)\""]
    });
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
  }

  return { workspace };
}

async function runCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit called with ${JSON.stringify(code)}`);
  });
  try {
    await createCli().parseAsync(["node", "devtask", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("process.exit called with")) {
      throw error;
    }
  }
  return lines.join("\n");
}
