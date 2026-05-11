import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, resolvePaths, taskDir, taskMetaPath } from "./paths.js";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import { acquireLock, releaseLock } from "./lock.js";
import { newRunId, writeRunRecord, type RunStatus } from "./run-record.js";
import { excludeDevtaskRuntimeFiles } from "./git.js";
import { recordStage } from "./stage-contracts.js";
import { clearActiveFixRequest, readActiveFixRequest } from "./fix-request.js";

export interface WorkerOptions {
  root?: string;
  intervalMs?: number;
}

export async function runWorker(id: string, options: WorkerOptions = {}): Promise<void> {
  const paths = resolvePaths(options.root ?? process.cwd());
  const intervalMs = options.intervalMs ?? 5_000;
  const dir = taskDir(paths, id);
  const lockPath = path.join(dir, "lock.json");

  updateMeta(paths, id, (meta) => ({
    ...meta,
    supervisorPid: process.pid,
    updatedAt: new Date().toISOString()
  }));

  try {
    while (true) {
      const meta = readTaskMeta(taskMetaPath(paths, id));
      if (meta.status !== "running") {
        return;
      }

      if (!acquireLock(lockPath)) {
        await sleep(2_000);
        continue;
      }

      try {
        await runOnce(paths, id);
      } finally {
        releaseLock(lockPath);
      }

      await sleep(intervalMs);
    }
  } finally {
    updateMeta(paths, id, (meta) => ({
      ...meta,
      supervisorPid: meta.supervisorPid === process.pid ? null : meta.supervisorPid,
      childPid: meta.supervisorPid === process.pid ? null : meta.childPid,
      updatedAt: new Date().toISOString()
    }));
  }
}

async function runOnce(paths: DevtaskPaths, id: string): Promise<void> {
  const meta = readTaskMeta(taskMetaPath(paths, id));
  const currentTaskDir = taskDir(paths, id);
  const runtimeStatePath = path.join(meta.worktreePath, ".devtask_state.md");
  const runtimeResultPath = path.join(meta.worktreePath, ".devtask_result.json");
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const logsDir = path.join(taskDir(paths, id), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  await excludeDevtaskRuntimeFiles(meta.worktreePath);
  prepareRuntimeFiles(meta.statePath, meta.resultPath, runtimeStatePath, runtimeResultPath);
  const promptPath = prepareWorkerPrompt(paths, meta);
  const fixRequest = readActiveFixRequest(paths, id);

  const logPath = path.join(logsDir, `${runId}.log`);
  const stdout = fs.openSync(logPath, "a");
  const stderr = fs.openSync(logPath, "a");
  let status: RunStatus = "success";
  let exitCode: number | null = 0;
  recordStage(paths, id, "run", {
    status: "running",
    startedAt,
    input: {
      command: meta.command,
      worktreePath: meta.worktreePath,
      promptPath,
      planPath: planMarkdownPath(paths, id)
    },
    artifacts: [logPath]
  });
  if (fixRequest) {
    recordStage(paths, id, "fix", {
      status: "running",
      startedAt,
      input: {
        fixId: fixRequest.fixId,
        source: fixRequest.source,
        summary: fixRequest.summary
      },
      artifacts: [fixRequest.promptPath]
    });
  }

  try {
    const child = spawn(meta.command, {
      shell: true,
      cwd: meta.worktreePath,
      env: {
        ...process.env,
        DEVTASK_ROOT: paths.root,
        DEVTASK_TASK_ID: id,
        DEVTASK_TASK_DIR: currentTaskDir,
        DEVTASK_TASK_PATH: promptPath,
        DEVTASK_PLAN_PATH: planMarkdownPath(paths, id),
        DEVTASK_STATE_PATH: runtimeStatePath,
        DEVTASK_RESULT_PATH: runtimeResultPath
      },
      stdio: ["ignore", stdout, stderr]
    });

    updateMeta(paths, id, (current) => ({
      ...current,
      childPid: child.pid ?? null,
      updatedAt: new Date().toISOString()
    }));

    exitCode = await waitForExit(child);
    status = exitCode === 0 ? "success" : "failed";
  } catch {
    status = "failed";
    exitCode = null;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  harvestRuntimeFiles(runtimeStatePath, runtimeResultPath, meta.statePath, meta.resultPath);

  const finishedAt = new Date().toISOString();
  const latest = readTaskMeta(taskMetaPath(paths, id));
  const nextFailCount = status === "success" ? 0 : latest.failCount + 1;
  const resultStatus = readResultStatus(latest.resultPath);
  const nextStatus =
    status === "failed" && nextFailCount >= latest.maxRetries
      ? "failed"
      : status === "success" && resultStatus === "done"
        ? "done"
        : status === "success" && resultStatus === "blocked"
          ? "blocked"
          : status === "success"
            ? "review"
        : latest.status;

  writeRunRecord(path.join(taskDir(paths, id), "runs"), {
    schemaVersion: 1,
    runId,
    taskId: id,
    status,
    command: latest.command,
    cwd: latest.worktreePath,
    logPath,
    startedAt,
    finishedAt,
    exitCode
  });

  recordStage(paths, id, "run", {
    status: nextStatus === "blocked" ? "blocked" : status === "success" ? "passed" : "failed",
    startedAt,
    finishedAt,
    output: {
      runId,
      exitCode,
      resultStatus,
      nextStatus,
      failCount: nextFailCount
    },
    artifacts: [logPath],
    reason: status === "failed" ? "worker command failed" : nextStatus === "blocked" ? "task result reported blocked" : null
  });
  if (fixRequest) {
    recordStage(paths, id, "fix", {
      status: status === "success" ? "passed" : "failed",
      startedAt,
      finishedAt,
      input: {
        fixId: fixRequest.fixId,
        source: fixRequest.source,
        summary: fixRequest.summary
      },
      output: {
        runId,
        exitCode,
        resultStatus,
        nextStatus
      },
      artifacts: [fixRequest.promptPath, logPath],
      reason: status === "success" ? null : "worker command failed while applying fix"
    });
    if (status === "success") {
      clearActiveFixRequest(paths, id);
    }
  }

  updateMeta(paths, id, (current) => ({
    ...current,
    status: nextStatus,
    childPid: null,
    failCount: nextFailCount,
    updatedAt: finishedAt
  }));
}

function prepareWorkerPrompt(paths: DevtaskPaths, meta: ReturnType<typeof readTaskMeta>): string {
  const planPath = planMarkdownPath(paths, meta.id);
  const fixRequest = readActiveFixRequest(paths, meta.id);
  if (!fs.existsSync(planPath) && !fixRequest) {
    return meta.taskPath;
  }

  const content = [
    fs.readFileSync(meta.taskPath, "utf8").trimEnd(),
    "",
    fs.existsSync(planPath) ? "## Accepted Plan" : "",
    "",
    fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8").trimEnd() : "",
    "",
    fixRequest ? "## Active Fix Request" : "",
    "",
    fixRequest ? fs.readFileSync(fixRequest.promptPath, "utf8").trimEnd() : "",
    ""
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
  const promptPath = path.join(taskDir(paths, meta.id), "runtime-task.md");
  fs.writeFileSync(promptPath, content);
  return promptPath;
}

function prepareRuntimeFiles(
  statePath: string,
  resultPath: string,
  runtimeStatePath: string,
  runtimeResultPath: string
): void {
  copyFileIfExists(statePath, runtimeStatePath);
  copyFileIfExists(resultPath, runtimeResultPath);
}

function harvestRuntimeFiles(
  runtimeStatePath: string,
  runtimeResultPath: string,
  statePath: string,
  resultPath: string
): void {
  copyFileIfExists(runtimeStatePath, statePath);
  copyFileIfExists(runtimeResultPath, resultPath);
}

function copyFileIfExists(source: string, destination: string): void {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.copyFileSync(source, destination);
}

function updateMeta(paths: DevtaskPaths, id: string, update: (meta: ReturnType<typeof readTaskMeta>) => ReturnType<typeof readTaskMeta>): void {
  const filePath = taskMetaPath(paths, id);
  writeTaskMeta(filePath, update(readTaskMeta(filePath)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(signal ? null : code);
    });
  });
}

function readResultStatus(resultPath: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown };
    return typeof value.status === "string" ? value.status : null;
  } catch {
    return null;
  }
}
