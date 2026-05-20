import fs from "node:fs";
import path from "node:path";
import { writeTaskMeta, readTaskMeta } from "./meta.js";
import { isProcessAlive } from "./processes.js";
import type { DevtaskPaths } from "./paths.js";
import { taskMetaPath } from "./paths.js";
import { tmuxSessionExists } from "./tmux.js";
import type { TaskMeta } from "./types.js";

export function reconcileTaskRuntime(paths: DevtaskPaths, meta: TaskMeta): TaskMeta {
  if (meta.status !== "running") {
    return meta;
  }

  if (isProcessAlive(meta.supervisorPid) || isProcessAlive(meta.childPid)) {
    return meta;
  }

  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    return meta;
  }

  const latest = readTaskMeta(taskMetaPath(paths, meta.id));
  if (latest.status !== "running") {
    return latest;
  }

  const now = new Date().toISOString();
  const next: TaskMeta = {
    ...latest,
    status: "failed",
    supervisorPid: null,
    childPid: null,
    tmuxSession: null,
    runtime: {
      state: "missing",
      reason: "runtime_lost",
      lastObservedAt: now
    },
    updatedAt: now
  };

  writeTaskMeta(taskMetaPath(paths, latest.id), next);
  return readTaskMeta(taskMetaPath(paths, latest.id));
}

function staleRuntimeReason(meta: TaskMeta): string {
  if (meta.tmuxSession) {
    return `recorded tmux session ${meta.tmuxSession} is not running${findStartupLogSuffix(meta)}`;
  }
  if (meta.supervisorPid || meta.childPid) {
    return `recorded worker process is not running`;
  }
  return "task was marked running but no live worker session exists";
}

function findStartupLogSuffix(meta: TaskMeta): string {
  try {
    const dir = path.join(path.dirname(meta.taskPath), "startup");
    if (!fs.existsSync(dir)) {
      return "";
    }
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".log")).sort();
    const latest = files.at(-1);
    return latest ? `; startup log: ${path.join(dir, latest)}` : "";
  } catch {
    return "";
  }
}
