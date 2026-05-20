import { DevtaskError } from "./infra/errors.js";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new DevtaskError(
      `Invalid task id "${id}". Use letters, numbers, dots, underscores, or hyphens; slashes are not allowed.`
    );
  }
}
