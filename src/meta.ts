import fs from "node:fs";
import { DevtaskError } from "./errors.js";
import { TASK_STATUSES, type TaskMeta, type TaskStatus } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid task metadata: ${field} must be a string`);
  }
  return value;
}

function requireNullableNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DevtaskError(`Invalid task metadata: ${field} must be a positive integer or null`);
  }
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DevtaskError(`Invalid task metadata: ${field} must be a non-negative integer`);
  }
  return value;
}

export function parseTaskMeta(value: unknown): TaskMeta {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid task metadata: expected an object");
  }

  if (value.schemaVersion !== 1) {
    throw new DevtaskError("Unsupported task metadata schema version");
  }

  if (!isTaskStatus(value.status)) {
    throw new DevtaskError("Invalid task metadata: status is not recognized");
  }

  return {
    schemaVersion: 1,
    id: requireString(value, "id"),
    status: value.status,
    branch: requireString(value, "branch"),
    worktreePath: requireString(value, "worktreePath"),
    taskPath: requireString(value, "taskPath"),
    statePath: requireString(value, "statePath"),
    resultPath: requireString(value, "resultPath"),
    supervisorPid: requireNullableNumber(value, "supervisorPid"),
    childPid: requireNullableNumber(value, "childPid"),
    failCount: requireNonNegativeInteger(value, "failCount"),
    maxRetries: requireNonNegativeInteger(value, "maxRetries"),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt")
  };
}

export function readTaskMeta(filePath: string): TaskMeta {
  return parseTaskMeta(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

export function writeTaskMeta(filePath: string, meta: TaskMeta): void {
  fs.writeFileSync(filePath, `${JSON.stringify(meta, null, 2)}\n`);
}
