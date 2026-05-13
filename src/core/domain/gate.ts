export type GateDecision = 'approved' | 'rejected';

export interface Gate {
  id: string;
  workId: string;
  taskId: string | null;   // null = Work-level gate
  stage: string;
  reason: string;
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  decision: GateDecision | null;
}
