import type { GatePolicy } from '../policy/gate-policy.js';

export type { GatePolicy };

export type StageTransition =
  | { goto: string }
  | { done: true }
  | { fail: true };

export interface StageDefinition {
  handler: string;               // registered handler name
  gate: GatePolicy;
  onSuccess: StageTransition;
  onFailure: StageTransition;
  maxAttempts?: number;
}

export interface WorkflowDefinition {
  entry: string;                              // name of the first stage
  stages: Record<string, StageDefinition>;   // named stage graph
}

// WorkflowConfig bundles the two pipeline definitions the engine uses.
// workPipeline governs Work-level phases (spec → exec → monitor).
// taskPipeline governs Task-level stages (run → check → fix → review → pr).
export interface WorkflowConfig {
  workPipeline: WorkflowDefinition;
  taskPipeline: WorkflowDefinition;
  maxConcurrentTasks: number;
}
