import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { taskDir } from "./paths.js";
import type { RunRecord } from "./run-record.js";
import type { TaskMeta } from "./types.js";
import { isProcessAlive } from "./processes.js";
import { runCommandOrThrow } from "./process-runner.js";

export interface TaskReview {
  meta: TaskMeta;
  changedFiles: string[];
  latestRun: RunRecord | null;
  result: unknown;
}

export interface DoctorIssue {
  taskId: string;
  message: string;
}

export async function buildTaskReview(paths: DevtaskPaths, meta: TaskMeta): Promise<TaskReview> {
  return {
    meta,
    changedFiles: await listChangedFiles(meta.worktreePath),
    latestRun: readLatestRun(paths, meta.id),
    result: readJsonIfExists(meta.resultPath)
  };
}

export function readLatestLogPath(paths: DevtaskPaths, id: string): string | null {
  const logsDir = path.join(taskDir(paths, id), "logs");
  if (!fs.existsSync(logsDir)) {
    return null;
  }

  const logs = fs
    .readdirSync(logsDir)
    .filter((file) => file.endsWith(".log"))
    .sort();

  const latest = logs.at(-1);
  return latest ? path.join(logsDir, latest) : null;
}

export function readLatestRun(paths: DevtaskPaths, id: string): RunRecord | null {
  const runsDir = path.join(taskDir(paths, id), "runs");
  if (!fs.existsSync(runsDir)) {
    return null;
  }

  const runs = fs
    .readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const latest = runs.at(-1);
  if (!latest) {
    return null;
  }

  return readJsonIfExists(path.join(runsDir, latest)) as RunRecord | null;
}

export function inspectTaskHealth(meta: TaskMeta): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  if (meta.status === "running" && !isProcessAlive(meta.supervisorPid)) {
    issues.push({
      taskId: meta.id,
      message: "status is running but supervisor process is not alive"
    });
  }

  if (meta.childPid && !isProcessAlive(meta.childPid)) {
    issues.push({
      taskId: meta.id,
      message: `child PID ${meta.childPid} is recorded but not alive`
    });
  }

  if (!fs.existsSync(meta.worktreePath)) {
    issues.push({
      taskId: meta.id,
      message: "worktree path is missing"
    });
  }

  return issues;
}

async function listChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const result = await runCommandOrThrow("git", ["status", "--short"], { cwd: worktreePath });
    return result.stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonIfExists(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}
