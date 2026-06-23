import crypto from 'node:crypto';
import type {
  NewSessionHistoryEvent,
  SessionLabels,
  SessionHistoryEvent,
  SessionOwner,
  SessionThread,
  SessionThreadQuery,
  TimelineBlock,
  TranscriptMessage,
} from './session-history.js';
import type { SessionHistoryStore } from './session-history-store.js';
import { now } from '../shared/time.js';
import { buildTimelineBlocks, buildTranscript } from './history-projection.js';

export class InMemorySessionHistoryStore implements SessionHistoryStore {
  private readonly threads = new Map<string, SessionThread>();
  private readonly events = new Map<string, SessionHistoryEvent[]>();
  private readonly delivered = new Map<string, string>();
  private readonly timelines = new Map<string, TimelineBlock[]>();

  createThread(thread: SessionThread): void {
    this.threads.set(thread.id, thread);
  }

  updateThread(thread: SessionThread): void {
    this.threads.set(thread.id, thread);
  }

  getThread(id: string): SessionThread | null {
    return this.threads.get(id) ?? null;
  }

  getActiveThread(owner: SessionOwner, labels: SessionLabels = {}): SessionThread | null {
    return [...this.threads.values()]
      .filter((thread) => thread.status === 'active' && sameOwner(thread.owner, owner) && hasLabels(thread.labels, labels))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }

  listThreads(query: SessionThreadQuery = {}): SessionThread[] {
    return [...this.threads.values()]
      .filter((thread) => matchesQuery(thread, query))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  appendEvent(input: NewSessionHistoryEvent): SessionHistoryEvent {
    const existing = this.events.get(input.threadId) ?? [];
    const event: SessionHistoryEvent = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      seq: existing.length + 1,
      occurredAt: input.occurredAt ?? now(),
      source: input.source,
      category: input.category,
      type: input.type,
      turnId: input.turnId ?? null,
      itemId: input.itemId ?? null,
      parentItemId: input.parentItemId ?? null,
      runtimeSessionId: input.runtimeSessionId ?? null,
      visibility: input.visibility ?? 'visible',
      payload: input.payload ?? {},
    };
    this.events.set(input.threadId, [...existing, event]);
    return event;
  }

  listEvents(threadId: string, fromSeq?: number): SessionHistoryEvent[] {
    return (this.events.get(threadId) ?? []).filter((event) => fromSeq === undefined || event.seq >= fromSeq);
  }

  deleteThreads(query: SessionThreadQuery): void {
    for (const thread of this.listThreads(query)) {
      this.threads.delete(thread.id);
      this.events.delete(thread.id);
      this.timelines.delete(thread.id);
    }
  }

  listTranscript(query: SessionThreadQuery): TranscriptMessage[] {
    return buildTranscript(
      this.listThreads(query),
      (threadId) => this.listEvents(threadId),
      (messageId) => this.delivered.get(messageId) ?? null,
    );
  }

  getUndeliveredUserMessages(query: SessionThreadQuery): TranscriptMessage[] {
    return this.listTranscript(query).filter((message) => message.role === 'user' && !message.deliveredAt);
  }

  markDelivered(messageIds: string[]): void {
    const ts = now();
    for (const id of messageIds) this.delivered.set(id, ts);
  }

  rebuildTimeline(threadId: string): void {
    this.timelines.set(threadId, buildTimelineBlocks(threadId, this.listEvents(threadId)));
  }

  listTimeline(threadId: string): TimelineBlock[] {
    return this.timelines.get(threadId) ?? [];
  }
}

function matchesQuery(thread: SessionThread, query: SessionThreadQuery): boolean {
  if (query.owner && !sameOwnerRef(thread.owner, query.owner)) return false;
  if (query.rootOwner && !matchesRootOwner(thread.owner, query.rootOwner)) return false;
  if (query.status && thread.status !== query.status) return false;
  if (query.labels && !hasLabels(thread.labels, query.labels)) return false;
  return true;
}

function sameOwner(a: SessionOwner, b: SessionOwner): boolean {
  return sameOwnerRef(a, b) && sameOwnerRef(a.parent, b.parent);
}

function sameOwnerRef(a: SessionOwner | SessionOwner['parent'] | undefined, b: SessionOwner | SessionOwner['parent'] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id;
}

function matchesRootOwner(owner: SessionOwner, root: SessionThreadQuery['rootOwner']): boolean {
  if (!root) return true;
  return sameOwnerRef(owner, root) || sameOwnerRef(owner.parent, root);
}

function hasLabels(labels: SessionLabels, expected: SessionLabels): boolean {
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}
