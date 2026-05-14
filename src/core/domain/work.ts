export type WorkStatus =
  | 'pending'      // created, not yet started
  | 'refining'     // refine phase in progress
  | 'architecting' // architect phase in progress
  | 'ready'        // plan approved, awaiting exec
  | 'running'      // task execution in progress
  | 'gated'        // waiting at a human gate
  | 'completed'    // all tasks done
  | 'failed';      // permanently failed

export interface Work {
  id: string;
  repoPaths: string[];         // all repos in scope (populated during refine)
  title: string;
  description: string | null;
  status: WorkStatus;
  specId?: string;
  mastraRunId?: string;
  createdAt: string;
  updatedAt: string;
}
