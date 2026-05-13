import type { WorkStatus } from '../domain/work.js';
import type { GateDecision } from '../domain/gate.js';

export type DomainEvent =
  | { kind: 'work_created';            workId: string; title: string;                                                            ts: number }
  | { kind: 'work_status_changed';     workId: string; status: WorkStatus;                                                       ts: number }
  | { kind: 'task_created';            workId: string; taskId: string;                                                           ts: number }
  | { kind: 'stage_started';           workId: string; taskId: string | null; stage: string; attemptId: string;                  ts: number }
  | { kind: 'stage_completed';         workId: string; taskId: string | null; stage: string; attemptId: string;                  ts: number }
  | { kind: 'stage_failed';            workId: string; taskId: string | null; stage: string; attemptId: string; reason: string;  ts: number }
  | { kind: 'gate_opened';             workId: string; taskId: string | null; stage: string; gateId: string;                     ts: number }
  | { kind: 'gate_closed';             workId: string; taskId: string | null; stage: string; gateId: string; decision: GateDecision; ts: number }
  | { kind: 'run_started';             workId: string; taskId: string | null; stage: string; runAttemptId: string;               ts: number }
  | { kind: 'run_completed';           workId: string; taskId: string | null; stage: string; runAttemptId: string;               ts: number }
  | { kind: 'run_failed';              workId: string; taskId: string | null; stage: string; runAttemptId: string; reason: string; ts: number }
  | { kind: 'run_heartbeat';           workId: string; runAttemptId: string;                                                     ts: number }
  | { kind: 'artifact_produced';       workId: string; taskId: string | null; stage: string; artifactId: string;                 ts: number }
  | { kind: 'agent_question_asked';    workId: string; runAttemptId: string; questionId: string; question: string;               ts: number }
  | { kind: 'agent_question_answered'; workId: string; runAttemptId: string; questionId: string;                                 ts: number }
  | { kind: 'pr_created';              workId: string; taskId: string; prUrl: string; prNumber: number;                          ts: number };
