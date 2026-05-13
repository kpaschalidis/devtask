import type { GatePolicy } from './gate-policy.js';
import type { RetryPolicy } from './retry-policy.js';

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1_000,
  maxBackoffMs: 300_000,
};

// Gate policies for the default task pipeline stages.
// --auto overrides all to 'auto' at runtime.
export const DEFAULT_STAGE_GATES: Record<string, GatePolicy> = {
  spec:    'required',
  plan:    'auto',
  run:     'auto',
  check:   'auto',
  fix:     'auto',
  review:  'auto',
  pr:      'required',
  monitor: 'auto',
};
