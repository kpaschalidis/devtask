export type SessionThreadStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface SessionOwnerRef {
  type: string;
  id: string;
}

export interface SessionOwner extends SessionOwnerRef {
  parent: SessionOwnerRef | null;
}

export type SessionLabels = Record<string, string>;

export interface SessionThreadQuery {
  owner?: SessionOwnerRef;
  rootOwner?: SessionOwnerRef;
  labels?: SessionLabels;
  status?: SessionThreadStatus;
}

export interface SessionThread {
  id: string;
  owner: SessionOwner;
  labels: SessionLabels;
  agentName: string;
  status: SessionThreadStatus;
  currentRuntimeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown>;
}

export type SessionHistoryEventSource = 'user' | 'agent' | 'system' | 'tool' | 'orchestrator';
export type SessionHistoryVisibility = 'visible' | 'hidden';
export type SessionTimelineView = 'product' | 'trace';

export type SessionHistoryEventCategory =
  | 'thread'
  | 'runtime'
  | 'turn'
  | 'message'
  | 'reasoning'
  | 'tool'
  | 'file'
  | 'human_input'
  | 'control'
  | 'usage';

export interface SessionHistoryEvent {
  id: string;
  threadId: string;
  seq: number;
  occurredAt: string;
  source: SessionHistoryEventSource;
  category: SessionHistoryEventCategory;
  type: string;
  turnId: string | null;
  itemId: string | null;
  parentItemId: string | null;
  runtimeSessionId: string | null;
  visibility: SessionHistoryVisibility;
  payload: Record<string, unknown>;
}

export interface NewSessionHistoryEvent {
  threadId: string;
  occurredAt?: string;
  source: SessionHistoryEventSource;
  category: SessionHistoryEventCategory;
  type: string;
  turnId?: string | null;
  itemId?: string | null;
  parentItemId?: string | null;
  runtimeSessionId?: string | null;
  visibility?: SessionHistoryVisibility;
  payload?: Record<string, unknown>;
}

export interface TranscriptMessage {
  id: string;
  owner: SessionOwner;
  labels: SessionLabels;
  role: 'agent' | 'user';
  kind: 'output' | 'thinking' | 'question' | 'answer' | 'user-initiated';
  content: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface TimelineBlock {
  id: string;
  threadId: string;
  blockSeq: number;
  kind: 'message' | 'reasoning' | 'tool' | 'file' | 'human_input' | 'control';
  status: 'open' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  title: string | null;
  bodyText: string;
  metadata: Record<string, unknown>;
}
