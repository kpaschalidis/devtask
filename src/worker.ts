import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DevtaskPaths } from "./paths.js";
import { resolvePaths, taskDir, taskMetaPath } from "./paths.js";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import { acquireLock, releaseLock } from "./lock.js";
import { newRunId, writeRunRecord, type RunStatus } from "./run-record.js";

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
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const logsDir = path.join(taskDir(paths, id), "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${runId}.log`);
  const stdout = fs.openSync(logPath, "a");
  const stderr = fs.openSync(logPath, "a");
  let status: RunStatus = "success";
  let exitCode: number | null = 0;

  try {
    const child = spawn(meta.command, {
      shell: true,
      cwd: meta.worktreePath,
      env: {
        ...process.env,
        DEVTASK_ROOT: paths.root,
        DEVTASK_TASK_ID: id,
        DEVTASK_TASK_DIR: currentTaskDir,
        DEVTASK_TASK_PATH: meta.taskPath,
        DEVTASK_STATE_PATH: meta.statePath,
        DEVTASK_RESULT_PATH: meta.resultPath
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

  updateMeta(paths, id, (current) => ({
    ...current,
    status: nextStatus,
    childPid: null,
    failCount: nextFailCount,
    updatedAt: finishedAt
  }));
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
