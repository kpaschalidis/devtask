import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySessionHistoryStore } from '../src/trace/in-memory-session-history-store.js';
import { SqliteSessionHistoryStore } from '../src/storage/sqlite/session-history-store.js';
import type { SessionHistoryStore } from '../src/trace/session-history-store.js';
import type { SessionThread } from '../src/trace/session-history.js';

interface DatabaseSyncLike {
  close(): void;
}

const databases: DatabaseSyncLike[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const cases: Array<[string, () => SessionHistoryStore]> = [
  ['memory', () => new InMemorySessionHistoryStore()],
];

const DatabaseSync = loadDatabaseSync();
if (DatabaseSync) {
  cases.push(['sqlite', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    return new SqliteSessionHistoryStore(db);
  }]);
}

describe.each(cases)('SessionHistoryStore contract: %s', (_name, createStore) => {
  it('projects equivalent queries, transcripts, delivery state, and timelines', () => {
    const store = createStore();
    seedStore(store);

    expect(store.listThreads({ rootOwner: { type: 'work', id: 'work-1' } })).toHaveLength(1);
    expect(store.getActiveThread(owner(), { phase: 'implement' })?.id).toBe('thread-1');

    const transcript = store.listTranscript({ owner: { type: 'phase-task', id: 'task-1' } });
    expect(transcript.map(({ id: _id, deliveredAt: _deliveredAt, ...message }) => message)).toEqual([
      expect.objectContaining({ role: 'user', content: 'build it', kind: 'user-initiated' }),
      expect.objectContaining({ role: 'agent', content: 'done', kind: 'output' }),
    ]);

    const userMessage = transcript.find((message) => message.role === 'user');
    expect(userMessage).toBeDefined();
    expect(store.getUndeliveredUserMessages({ owner: { type: 'phase-task', id: 'task-1' } })).toHaveLength(1);
    store.markDelivered([userMessage!.id]);
    expect(store.getUndeliveredUserMessages({ owner: { type: 'phase-task', id: 'task-1' } })).toHaveLength(0);

    const timeline = store.listTimeline('thread-1');
    expect(timeline.map(({ id: _id, ...block }) => block)).toEqual([
      expect.objectContaining({ kind: 'message', status: 'completed', bodyText: 'build it' }),
      expect.objectContaining({ kind: 'message', status: 'completed', bodyText: 'done' }),
    ]);
  });
});

function loadDatabaseSync(): (new (path: string) => DatabaseSyncLike) | null {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };
    return sqlite.DatabaseSync;
  } catch {
    return null;
  }
}

function seedStore(store: SessionHistoryStore): void {
  const thread: SessionThread = {
    id: 'thread-1',
    owner: owner(),
    labels: { phase: 'implement' },
    agentName: 'test',
    status: 'active',
    currentRuntimeSessionId: 'runtime-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    metadata: {},
  };
  store.createThread(thread);
  store.appendEvent({
    threadId: thread.id,
    occurredAt: '2026-01-01T00:00:01.000Z',
    source: 'user',
    category: 'message',
    type: 'message.sent',
    payload: { role: 'user', text: 'build it', kind: 'user-initiated' },
  });
  store.appendEvent({
    threadId: thread.id,
    occurredAt: '2026-01-01T00:00:02.000Z',
    source: 'agent',
    category: 'message',
    type: 'message.delta',
    turnId: 'turn-1',
    payload: { role: 'assistant', text: 'do' },
  });
  store.appendEvent({
    threadId: thread.id,
    occurredAt: '2026-01-01T00:00:03.000Z',
    source: 'agent',
    category: 'message',
    type: 'message.delta',
    turnId: 'turn-1',
    payload: { role: 'assistant', text: 'ne' },
  });
  store.appendEvent({
    threadId: thread.id,
    occurredAt: '2026-01-01T00:00:04.000Z',
    source: 'agent',
    category: 'message',
    type: 'message.completed',
    turnId: 'turn-1',
    payload: { role: 'assistant' },
  });
  store.rebuildTimeline(thread.id);
}

function owner() {
  return {
    type: 'phase-task',
    id: 'task-1',
    parent: { type: 'work', id: 'work-1' },
  };
}
