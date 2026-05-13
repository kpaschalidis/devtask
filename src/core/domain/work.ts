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
  title: string;
  description: string | null;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
}
