export type RunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_input';

export interface SessionHandle {
  id: string;
  threadId: string;
}

export interface RunAttempt {
  id: string;
  workId: string;
  taskId: string | null;
  stageAttemptId: string;
  stage: string;
  status: RunStatus;
  runtime: string;
  sessionHandle: SessionHandle | null;
  logPath: string | null;
  startedAt: string;
  lastHeartbeatAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  failureReason: string | null;
}
