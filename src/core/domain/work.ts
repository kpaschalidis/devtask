export type WorkStatus =
  | 'pending'     // created, awaiting spec
  | 'speccing'    // spec in progress
  | 'ready'       // spec approved, awaiting exec
  | 'running'     // execution in progress
  | 'gated'       // waiting at a human gate
  | 'completed'   // all tasks done
  | 'failed';     // permanently failed

export interface Work {
  id: string;
  repoPath: string;
  title: string;
  description: string | null;
  status: WorkStatus;
  mastraRunId?: string;
  createdAt: string;
  updatedAt: string;
}
