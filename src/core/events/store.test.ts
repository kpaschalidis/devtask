import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteEventStore } from './sqlite.js';
import type { EventStore } from './store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new SqliteEventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('history returns events in insertion order for a work item', () => {
    store.append({ kind: 'work_created',        workId: 'w-1', title: 'Fix bug', ts: 1 });
    store.append({ kind: 'work_status_changed', workId: 'w-1', status: 'speccing', ts: 2 });
    store.append({ kind: 'work_status_changed', workId: 'w-1', status: 'running', ts: 3 });

    const events = store.history('w-1');
    expect(events.map((e) => e.kind)).toEqual([
      'work_created',
      'work_status_changed',
      'work_status_changed',
    ]);
  });

  it('history is scoped to the requested work item', () => {
    store.append({ kind: 'work_created', workId: 'w-1', title: 'Task one', ts: 1 });
    store.append({ kind: 'work_created', workId: 'w-2', title: 'Task two', ts: 2 });
    store.append({ kind: 'work_status_changed', workId: 'w-1', status: 'running', ts: 3 });

    expect(store.history('w-1')).toHaveLength(2);
    expect(store.history('w-2')).toHaveLength(1);
  });

  it('history returns empty array for unknown work item', () => {
    expect(store.history('unknown')).toEqual([]);
  });

  it('preserves full event payload on round-trip', () => {
    const event = {
      kind: 'stage_started' as const,
      workId: 'w-1',
      taskId: 't-1',
      stage: 'run',
      attemptId: 'a-1',
      ts: 42,
    };
    store.append(event);
    expect(store.history('w-1')[0]).toEqual(event);
  });
});
