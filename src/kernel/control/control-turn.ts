import type { z } from 'zod';
import type { RuntimeHandle } from '../sessions/session.js';

export interface AgentControlTurn<T> {
  handle: RuntimeHandle;
  prompt: string;
  outputSchema: unknown;
  validator: z.ZodType<T>;
  maxAttempts?: number;
}

export interface AgentControlTurnResult<T> {
  value: T;
  rawOutput: string;
}
