export type TaskStatus =
  | 'pending'
  | 'running'
  | 'gated'
  | 'completed'
  | 'failed';

export interface Task {
  id: string;
  workId: string;
  repoPath: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  dependsOn: string[];   // taskIds this task must wait for
  createdAt: string;
  updatedAt: string;
}
