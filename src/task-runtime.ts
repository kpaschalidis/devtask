import { writeTaskMeta, readTaskMeta } from "./meta.js";
import { isProcessAlive } from "./processes.js";
import type { DevtaskPaths } from "./paths.js";
import { taskMetaPath } from "./paths.js";
import { readStageLedger, recordStage } from "./stage-contracts.js";
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

  const now = new Date().toISOString();
  const next: TaskMeta = {
    ...meta,
    status: "failed",
    supervisorPid: null,
    childPid: null,
    tmuxSession: null,
    updatedAt: now
  };
  writeTaskMeta(taskMetaPath(paths, meta.id), next);

  const runStage = readStageLedger(paths, meta.id).stages.run;
  if (runStage?.status === "running") {
    recordStage(paths, meta.id, "run", {
      status: "failed",
      input: runStage.input,
      output: runStage.output,
      artifacts: runStage.artifacts,
      reason: staleRuntimeReason(meta)
    });
  }

  return readTaskMeta(taskMetaPath(paths, meta.id));
}

function staleRuntimeReason(meta: TaskMeta): string {
  if (meta.tmuxSession) {
    return `recorded tmux session ${meta.tmuxSession} is not running`;
  }
  if (meta.supervisorPid || meta.childPid) {
    return `recorded worker process is not running`;
  }
  return "task was marked running but no live worker session exists";
}
