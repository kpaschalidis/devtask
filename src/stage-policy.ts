import type { DevtaskConfig } from "./config.js";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import type { TaskMeta } from "./types.js";
import { readLatestVerification } from "./verification.js";

export function assertReviewReady(paths: DevtaskPaths, meta: TaskMeta, config: DevtaskConfig): void {
  if (config.verify.length === 0) {
    return;
  }

  const latest = readLatestVerification(paths, meta.id);
  if (!latest) {
    throw new DevtaskError(`Task ${meta.id} has not passed checks. Run devtask check ${meta.id} first.`);
  }

  if (latest.status !== "passed") {
    throw new DevtaskError(`Task ${meta.id} checks are ${latest.status}. Fix checks before review.`);
  }
}
