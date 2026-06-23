import type { SessionHistoryEventCategory, SessionHistoryVisibility } from './session-history.js';

export type AgentTraceEvent =
  | TraceTurnStarted
  | TraceTurnCompleted
  | TraceTurnFailed
  | TraceMessageSent
  | TraceMessageDelta
  | TraceMessageCompleted
  | TraceReasoningStarted
  | TraceReasoningDelta
  | TraceReasoningCompleted
  | TraceToolStarted
  | TraceToolOutputDelta
  | TraceToolCompleted
  | TraceFileChanged
  | TracePatchGenerated
  | TracePermissionRequested
  | TracePermissionResolved
  | TraceHumanInputRequested
  | TraceHumanInputResolved
  | TraceUsageUpdated
  | TraceArtifactCreated;

export type AgentSessionHistoryEvent = AgentTraceEvent;

export interface TraceEventEnvelope {
  type: string;
  turnId?: string;
  itemId?: string;
  parentItemId?: string;
  title?: string;
  summary?: string;
  visibility?: SessionHistoryVisibility;
  payload?: Record<string, unknown>;
  adapter?: {
    name: string;
    eventType?: string;
    eventId?: string;
    raw?: unknown;
  };
}

export interface TraceTurnStarted extends TraceEventEnvelope {
  type: 'turn.started';
}

export interface TraceTurnCompleted extends TraceEventEnvelope {
  type: 'turn.completed';
}

export interface TraceTurnFailed extends TraceEventEnvelope {
  type: 'turn.failed';
  error: string;
}

export interface TraceMessageSent extends TraceEventEnvelope {
  type: 'message.sent';
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  kind?: string;
}

export interface TraceMessageDelta extends TraceEventEnvelope {
  type: 'message.delta';
  role: 'assistant' | 'tool' | 'system';
  text: string;
}

export interface TraceMessageCompleted extends TraceEventEnvelope {
  type: 'message.completed';
  role: 'assistant' | 'tool' | 'system';
}

export interface TraceReasoningStarted extends TraceEventEnvelope {
  type: 'reasoning.started';
}

export interface TraceReasoningDelta extends TraceEventEnvelope {
  type: 'reasoning.delta';
  text: string;
}

export interface TraceReasoningCompleted extends TraceEventEnvelope {
  type: 'reasoning.completed';
  durationMs?: number;
}

export interface TraceToolStarted extends TraceEventEnvelope {
  type: 'tool.started';
  name: string;
  input?: unknown;
}

export interface TraceToolOutputDelta extends TraceEventEnvelope {
  type: 'tool.output.delta';
  stream?: 'stdout' | 'stderr' | 'combined';
  text: string;
}

export interface TraceToolCompleted extends TraceEventEnvelope {
  type: 'tool.completed';
  exitCode?: number;
  durationMs?: number;
}

export interface TraceFileChanged extends TraceEventEnvelope {
  type: 'file.changed';
  path?: string;
  action?: 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';
  diff?: string;
  text?: string;
}

export interface TracePatchGenerated extends TraceEventEnvelope {
  type: 'patch.generated';
  path?: string;
  diff: string;
}

export interface TracePermissionRequested extends TraceEventEnvelope {
  type: 'permission.requested';
  prompt: string;
}

export interface TracePermissionResolved extends TraceEventEnvelope {
  type: 'permission.resolved';
  decision: 'approved' | 'rejected' | 'cancelled';
}

export interface TraceHumanInputRequested extends TraceEventEnvelope {
  type: 'human_input.requested';
  prompt: string;
}

export interface TraceHumanInputResolved extends TraceEventEnvelope {
  type: 'human_input.resolved';
  response: string;
}

export interface TraceUsageUpdated extends TraceEventEnvelope {
  type: 'usage.updated';
  usage: Record<string, unknown>;
}

export interface TraceArtifactCreated extends TraceEventEnvelope {
  type: 'artifact.created';
  artifactType: string;
  uri?: string;
}

export function categoryForAgentEvent(type: AgentTraceEvent['type']): SessionHistoryEventCategory {
  if (type.startsWith('turn.')) return 'turn';
  if (type.startsWith('message.')) return 'message';
  if (type.startsWith('reasoning.')) return 'reasoning';
  if (type.startsWith('tool.')) return 'tool';
  if (type === 'file.changed' || type === 'patch.generated') return 'file';
  if (type.startsWith('permission.')) return 'control';
  if (type.startsWith('human_input.')) return 'human_input';
  if (type.startsWith('usage.')) return 'usage';
  return 'control';
}

export function payloadForAgentEvent(event: AgentTraceEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...(event.payload ?? {}),
  };
  for (const [key, value] of Object.entries(event)) {
    if (['type', 'turnId', 'itemId', 'parentItemId', 'visibility', 'payload'].includes(key)) continue;
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}
