import fs from "node:fs";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import { isProcessAlive } from "./processes.js";
import type { DevtaskPaths } from "./paths.js";
import { taskMetaPath } from "./paths.js";
import { readStageLedger, recordStage } from "./stage-contracts.js";
import { tmuxSessionExists } from "./tmux.js";
import type { TaskMeta } from "./types.js";

export function runRecovery(paths: DevtaskPaths): void {
  if (!fs.existsSync(paths.tasksDir)) return;

  const taskIds = fs
    .readdirSync(paths.tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const id of taskIds) {
    try {
      recoverTask(paths, id);
    } catch {
      // Never let one bad task block recovery of the others
    }
  }
}

export function recoverTask(paths: DevtaskPaths, id: string): void {
  const metaPath = taskMetaPath(paths, id);
  if (!fs.existsSync(metaPath)) return;

  const meta = readTaskMeta(metaPath);
  if (meta.status !== "running") return;

  if (isRuntimeAlive(meta)) {
    markAlive(paths, id, meta);
    return;
  }

  // Re-read to avoid a TOCTOU race where the worker just finished
  const latest = readTaskMeta(metaPath);
  if (latest.status !== "running") return;

  markRuntimeLost(paths, id, latest);
}

function isRuntimeAlive(meta: TaskMeta): boolean {
  if (isProcessAlive(meta.supervisorPid)) return true;
  if (isProcessAlive(meta.childPid)) return true;
  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) return true;
  return false;
}

function markAlive(paths: DevtaskPaths, id: string, meta: TaskMeta): void {
  const now = new Date().toISOString();
  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    lifecycle: {
      version: 1,
      runtime: {
        state: "alive",
        reason: "process_running",
        lastObservedAt: now
      }
    },
    updatedAt: now
  });
}

function markRuntimeLost(paths: DevtaskPaths, id: string, meta: TaskMeta): void {
  const now = new Date().toISOString();
  const next: TaskMeta = {
    ...meta,
    status: "failed",
    supervisorPid: null,
    childPid: null,
    tmuxSession: null,
    lifecycle: {
      version: 1,
      runtime: {
        state: "missing",
        reason: "runtime_lost",
        lastObservedAt: now
      }
    },
    updatedAt: now
  };

  const runStage = readStageLedger(paths, id).stages.run;
  if (runStage?.status === "running") {
    recordStage(paths, id, "run", {
      status: "failed",
      input: runStage.input,
      output: runStage.output,
      artifacts: runStage.artifacts,
      reason: buildLostReason(meta)
    });
  }

  writeTaskMeta(taskMetaPath(paths, id), next);
}

function buildLostReason(meta: TaskMeta): string {
  if (meta.tmuxSession) {
    return `tmux session ${meta.tmuxSession} no longer exists (runtime_lost on recovery)`;
  }
  if (meta.supervisorPid || meta.childPid) {
    return "worker process is not running (runtime_lost on recovery)";
  }
  return "task was marked running but no live runtime found on recovery";
}
