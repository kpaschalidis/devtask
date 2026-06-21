import type { RuntimeHandle } from '../sessions/session.js';
import type { Runtime } from '../runtime/runtime.js';
import type { AgentSessionHistoryEvent } from '../trace/session-history-events.js';
import type { PreparedSessionInstructions } from '../instructions/instruction-payload.js';

export type RunEvent =
  | { kind: 'output'; text: string }
  | { kind: 'turn_complete' }
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  | { kind: 'stalled' }
  | { kind: 'max_turn_exceeded' }
  | { kind: 'input_required'; prompt: string };

export type ActivityState = 'active' | 'idle' | 'waiting_input' | 'errored' | 'unknown';

export interface RunOptions {
  maxTurnMs?: number;
  stallMs?: number;
}

export interface SendMessageOptions {
  outputSchema?: unknown;
  history?: {
    kind?: string;
    visible?: boolean;
  };
}

export interface AgentCostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AgentSessionInfo {
  summary: string | null;
  summaryIsFallback: boolean;
  agentSessionId: string;
  metadata?: Record<string, string>;
  cost?: AgentCostEstimate;
}

export type AgentTurnCancellationResult =
  | { mode: 'graceful'; message?: string }
  | { mode: 'hard'; message?: string }
  | { mode: 'unsupported'; message?: string };

export interface AgentCreateSessionInput {
  workspacePath: string;
  sessionId: string;
  environment: Record<string, string>;
  instructions: PreparedSessionInstructions;
  onHistoryEvent?: (event: AgentSessionHistoryEvent) => void;
}

export interface AgentRestoreSessionInput extends AgentCreateSessionInput {
  previousHandle: RuntimeHandle;
}

export interface Agent {
  readonly name: string;
  readonly promptDelivery: 'inline' | 'post-launch';
  getLaunchCommand(workspacePath: string, instructions?: PreparedSessionInstructions): Promise<string>;
  getEnvironment(workspacePath: string): Record<string, string>;
  readEvents(handle: RuntimeHandle, runtime: Runtime, opts?: RunOptions): AsyncIterable<RunEvent>;
  sendMessage?(handle: RuntimeHandle, runtime: Runtime, taskInput: string, opts?: SendMessageOptions): Promise<void>;
  getActivityState?(handle: RuntimeHandle, runtime: Runtime): Promise<ActivityState>;
  getSessionInfo?(handle: RuntimeHandle): Promise<AgentSessionInfo | null>;
  getRestoreCommand?(handle: RuntimeHandle): Promise<string | null>;
  restoreSession?(input: AgentRestoreSessionInput): Promise<RuntimeHandle>;
  release?(handle: RuntimeHandle): void;
  createSession?(input: AgentCreateSessionInput): Promise<RuntimeHandle>;
  isSessionAlive?(handle: RuntimeHandle): Promise<boolean>;
  cancelTurn?(handle: RuntimeHandle, runtime: Runtime): Promise<AgentTurnCancellationResult>;
}
