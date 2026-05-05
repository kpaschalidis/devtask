export const TASK_STATUSES = [
  "created",
  "running",
  "paused",
  "review",
  "blocked",
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
  model: string | null;
  command: string;
  supervisorPid: number | null;
  childPid: number | null;
  tmuxSession: string | null;
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
