import crypto from 'node:crypto';
import type { SessionHistoryStore } from './session-history-store.js';
import type {
  NewSessionHistoryEvent,
  SessionHistoryEvent,
  SessionLabels,
  SessionOwner,
  SessionThread,
  SessionThreadStatus,
} from './session-history.js';
import { now } from '../shared/time.js';

export interface OpenThreadInput {
  owner: SessionOwner;
  labels?: SessionLabels;
  agentName: string;
  runtimeSessionId: string;
  metadata?: Record<string, unknown>;
}

export class SessionHistoryCaptureService {
  constructor(
    private readonly store: SessionHistoryStore,
    private readonly onEvent?: (event: SessionHistoryEvent) => void,
  ) {}

  openThread(input: OpenThreadInput): SessionThread {
    const labels = input.labels ?? {};
    const existing = this.store.getActiveThread(input.owner, labels);
    if (existing) {
      this.attachRuntime(existing.id, input.runtimeSessionId, input.metadata);
      return existing;
    }

    const ts = now();
    const thread: SessionThread = {
      id: crypto.randomUUID(),
      owner: input.owner,
      labels,
      agentName: input.agentName,
      status: 'active',
      currentRuntimeSessionId: input.runtimeSessionId,
      startedAt: ts,
      endedAt: null,
      metadata: input.metadata ?? {},
    };
    this.store.createThread(thread);
    this.append(thread.id, {
      source: 'system',
      category: 'thread',
      type: 'thread.started',
      runtimeSessionId: input.runtimeSessionId,
      payload: { owner: input.owner, labels, agentName: input.agentName },
    });
    this.append(thread.id, {
      source: 'system',
      category: 'runtime',
      type: 'runtime.attached',
      runtimeSessionId: input.runtimeSessionId,
      payload: input.metadata ?? {},
    });
    return thread;
  }

  attachRuntime(threadId: string, runtimeSessionId: string, metadata?: Record<string, unknown>): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    if (thread.currentRuntimeSessionId && thread.currentRuntimeSessionId !== runtimeSessionId) {
      this.append(threadId, {
        source: 'system',
        category: 'runtime',
        type: 'runtime.detached',
        runtimeSessionId: thread.currentRuntimeSessionId,
        payload: {},
      });
    }
    this.store.updateThread({ ...thread, currentRuntimeSessionId: runtimeSessionId, metadata: { ...thread.metadata, ...(metadata ?? {}) } });
    this.append(threadId, {
      source: 'system',
      category: 'runtime',
      type: 'runtime.attached',
      runtimeSessionId,
      payload: metadata ?? {},
    });
  }

  append(threadId: string, event: Omit<NewSessionHistoryEvent, 'threadId'>): SessionHistoryEvent {
    const persisted = this.store.appendEvent({ ...event, threadId });
    this.store.rebuildTimeline(threadId);
    this.onEvent?.(persisted);
    return persisted;
  }

  closeThread(threadId: string, status: SessionThreadStatus, payload: Record<string, unknown> = {}): void {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.status !== 'active') return;
    const endedAt = now();
    this.append(threadId, {
      source: 'system',
      category: 'thread',
      type: status === 'completed' ? 'thread.completed' : status === 'failed' ? 'thread.failed' : 'thread.abandoned',
      runtimeSessionId: thread.currentRuntimeSessionId,
      payload,
    });
    this.store.updateThread({ ...thread, status, endedAt, currentRuntimeSessionId: null });
  }
}
