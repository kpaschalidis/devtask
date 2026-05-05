export const TASK_STATUSES = [
  "created",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskMeta {
  schemaVersion: 1;
  id: string;
  status: TaskStatus;
  branch: string;
  worktreePath: string;
  taskPath: string;
  statePath: string;
  resultPath: string;
  command: string;
  supervisorPid: number | null;
  childPid: number | null;
  failCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  status: TaskStatus;
  branch: string;
  worktreePath: string;
  supervisorPid: number | null;
  childPid: number | null;
  failCount: number;
  maxRetries: number;
  updatedAt: string;
}
