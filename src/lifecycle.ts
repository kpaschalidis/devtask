import { DevtaskError } from "./errors.js";
import type { TaskMeta, TaskStatus } from "./types.js";

export const MANUAL_STATUSES = ["review", "done", "blocked", "cancelled"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export function parseManualStatus(value: string): ManualStatus {
  if (MANUAL_STATUSES.includes(value as ManualStatus)) {
    return value as ManualStatus;
  }

  throw new DevtaskError(`Invalid manual status "${value}". Use one of: ${MANUAL_STATUSES.join(", ")}`);
}

export function assertCanMark(meta: TaskMeta, status: TaskStatus): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is running; pause or cancel it before marking it`);
  }

  if (status === "running" || status === "paused" || status === "failed" || status === "created") {
    throw new DevtaskError(`Cannot manually mark task ${meta.id} as ${status}`);
  }
}
