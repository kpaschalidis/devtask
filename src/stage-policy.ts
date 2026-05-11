import type { DevtaskConfig } from "./config.js";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { readStageLedger } from "./stage-contracts.js";
import type { TaskMeta } from "./types.js";
import { readLatestVerification } from "./verification.js";

export function assertRunReady(meta: TaskMeta): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is already running.`);
  }

  if (meta.status === "created") {
    throw new DevtaskError(`Task ${meta.id} has not been planned. Run devtask task plan ${meta.id} first.`);
  }

  if (["approved", "pr-open", "ci-running", "ci-passed", "done", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${meta.id} is ${meta.status} and cannot be run.`);
  }
}

export function assertCheckReady(paths: DevtaskPaths, meta: TaskMeta): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is running; stop it before checking.`);
  }

  if (!hasPassedRun(paths, meta)) {
    throw new DevtaskError(`Task ${meta.id} has not completed implementation. Run devtask task run ${meta.id} first.`);
  }
}

export function assertReviewReady(paths: DevtaskPaths, meta: TaskMeta, config: DevtaskConfig): void {
  assertCheckReady(paths, meta);

  if (config.verify.length === 0) {
    return;
  }

  const latest = readLatestVerification(paths, meta.id);
  if (!latest) {
    throw new DevtaskError(`Task ${meta.id} has not passed checks. Run devtask task check ${meta.id} first.`);
  }

  if (latest.status !== "passed") {
    throw new DevtaskError(`Task ${meta.id} checks are ${latest.status}. Fix checks before review.`);
  }
}

export function assertCommitReady(paths: DevtaskPaths, meta: TaskMeta): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is running; stop it before committing.`);
  }

  if (meta.status !== "approved") {
    throw new DevtaskError(`Task ${meta.id} is ${meta.status}; approve it before committing.`);
  }
}

export function assertPrReady(meta: TaskMeta): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is running; stop it before opening a PR.`);
  }

  if (!["approved", "ci-failed"].includes(meta.status)) {
    throw new DevtaskError(`Task ${meta.id} is ${meta.status}; approve it before opening a PR.`);
  }
}

export function assertCiReady(meta: TaskMeta): asserts meta is TaskMeta & { prUrl: string } {
  if (!meta.prUrl) {
    throw new DevtaskError(`Task ${meta.id} has no PR URL. Open a PR first.`);
  }
}

function hasPassedRun(paths: DevtaskPaths, meta: TaskMeta): boolean {
  if (["review", "approved", "pr-open", "ci-running", "ci-failed", "ci-passed", "done"].includes(meta.status)) {
    return true;
  }

  return readStageLedger(paths, meta.id).stages.run?.status === "passed";
}
