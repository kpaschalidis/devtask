import type { WorkflowConfig, WorkflowDefinition } from './workflow-definition.js';

export const DEFAULT_WORK_PIPELINE: WorkflowDefinition = {
  entry: 'spec',
  stages: {
    spec:    { handler: 'spec',    gate: 'required', onSuccess: { goto: 'exec' },    onFailure: { fail: true } },
    exec:    { handler: 'exec',    gate: 'auto',     onSuccess: { goto: 'monitor' }, onFailure: { fail: true } },
    monitor: { handler: 'monitor', gate: 'auto',     onSuccess: { done: true },      onFailure: { fail: true } },
  },
};

export const DEFAULT_TASK_PIPELINE: WorkflowDefinition = {
  entry: 'run',
  stages: {
    plan:   { handler: 'agent',   gate: 'auto',     onSuccess: { goto: 'run' },    onFailure: { fail: true } },
    run:    { handler: 'agent',   gate: 'auto',     onSuccess: { goto: 'check' },  onFailure: { fail: true } },
    check:  { handler: 'verify',  gate: 'auto',     onSuccess: { goto: 'review' }, onFailure: { goto: 'fix' } },
    fix:    { handler: 'agent',   gate: 'auto',     onSuccess: { goto: 'run' },    onFailure: { fail: true }, maxAttempts: 3 },
    review: { handler: 'agent',   gate: 'auto',     onSuccess: { goto: 'pr' },     onFailure: { goto: 'fix' } },
    pr:     { handler: 'publish', gate: 'required', onSuccess: { done: true },     onFailure: { fail: true } },
  },
};

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  workPipeline: DEFAULT_WORK_PIPELINE,
  taskPipeline: DEFAULT_TASK_PIPELINE,
  maxConcurrentTasks: 5,
};
