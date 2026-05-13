import type { SessionHandle } from '../domain/run-attempt.js';

export type { SessionHandle };

export type RunEvent =
  | { kind: 'output'; text: string }
  | { kind: 'turn_complete' }
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  | { kind: 'stalled' }
  | { kind: 'input_required'; prompt: string };

export interface RunOptions {
  maxTurnMs?: number;
  stallMs?: number;
}

export type ActivityState =
  | 'active'
  | 'idle'
  | 'waiting_input'
  | 'errored'
  | 'unknown';

export interface AgentRunner {
  readonly command?: string;
  start(workspacePath: string): Promise<SessionHandle>;
  run(session: SessionHandle, prompt: string, opts?: RunOptions): AsyncIterable<RunEvent>;
  stop(session: SessionHandle): Promise<void>;
  getActivityState?(session: SessionHandle): Promise<ActivityState>;
  pause?(session: SessionHandle): Promise<void>;
  resume?(session: SessionHandle): Promise<void>;
  sendInput?(session: SessionHandle, message: string): Promise<void>;
}
