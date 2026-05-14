export type TaskStatus =
  | 'pending'
  | 'running'
  | 'gated'
  | 'completed'
  | 'failed';

export interface SessionHandle {
  id: string;        // tmux session name
  threadId: string;  // Codex thread ID for resume
}

export interface Task {
  id: string;
  workId: string;
  repoPath: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  dependsOn: string[];
  acceptanceCriteria: string[];
  filesToCreate: string[];
  filesToModify: string[];
  phase: number;
  verifyScript?: string;
  sessionHandle?: SessionHandle;
  mastraRunId?: string;
  createdAt: string;
  updatedAt: string;
}
