export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'gated';

export interface StageAttempt {
  id: string;
  workId: string;
  taskId: string | null;   // null = Work-level phase, string = Task-level stage
  stage: string;
  attemptNumber: number;
  status: StageStatus;
  startedAt: string;
  finishedAt: string | null;
  failureReason: string | null;
}
