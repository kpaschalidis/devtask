import fs from 'node:fs';
import path from 'node:path';
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
} from '../../trace/session-history.js';
import type { SessionHistoryStore } from '../../trace/session-history-store.js';
import { now } from '../../shared/time.js';
import { buildTimelineBlocks, buildTranscript } from '../../trace/history-projection.js';

interface PersistedState {
  schemaVersion: 1;
  threads: SessionThread[];
  events: Record<string, SessionHistoryEvent[]>;
  delivered: Record<string, string>;
  timelines: Record<string, TimelineBlock[]>;
}

const EMPTY_STATE: PersistedState = {
  schemaVersion: 1,
  threads: [],
  events: {},
  delivered: {},
  timelines: {},
};

export class FileSessionHistoryStore implements SessionHistoryStore {
  private readonly threads: Map<string, SessionThread>;
  private readonly events: Map<string, SessionHistoryEvent[]>;
  private readonly delivered: Map<string, string>;
  private readonly timelines: Map<string, TimelineBlock[]>;

  constructor(private readonly filePath: string) {
    const state = readState(filePath);
    this.threads = new Map(state.threads.map((thread) => [thread.id, thread]));
    this.events = new Map(Object.entries(state.events));
    this.delivered = new Map(Object.entries(state.delivered));
    this.timelines = new Map(Object.entries(state.timelines));
  }

  createThread(thread: SessionThread): void {
    this.threads.set(thread.id, thread);
    this.persist();
  }

  updateThread(thread: SessionThread): void {
    this.threads.set(thread.id, thread);
    this.persist();
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
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  rebuildTimeline(threadId: string): void {
    this.timelines.set(threadId, buildTimelineBlocks(threadId, this.listEvents(threadId)));
    this.persist();
  }

  listTimeline(threadId: string): TimelineBlock[] {
    return this.timelines.get(threadId) ?? [];
  }

  close(): void {
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({
      schemaVersion: 1,
      threads: [...this.threads.values()],
      events: Object.fromEntries(this.events),
      delivered: Object.fromEntries(this.delivered),
      timelines: Object.fromEntries(this.timelines),
    } satisfies PersistedState, null, 2)}\n`);
    fs.renameSync(tmpPath, this.filePath);
  }
}

function readState(filePath: string): PersistedState {
  if (!fs.existsSync(filePath)) {
    return EMPTY_STATE;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error(`Invalid session history store file: ${filePath}`);
  }
  const record = raw as {
    threads?: unknown;
    events?: unknown;
    delivered?: unknown;
    timelines?: unknown;
  };
  return {
    schemaVersion: 1,
    threads: Array.isArray(record.threads) ? record.threads as SessionThread[] : [],
    events: isRecord(record.events) ? record.events as Record<string, SessionHistoryEvent[]> : {},
    delivered: isRecord(record.delivered) ? record.delivered as Record<string, string> : {},
    timelines: isRecord(record.timelines) ? record.timelines as Record<string, TimelineBlock[]> : {},
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
