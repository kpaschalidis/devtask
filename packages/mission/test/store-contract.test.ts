import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMissionStore } from '../src/store/in-memory-store.js';
import { SqliteMissionStore } from '../src/store/sqlite-store.js';
import { StaleRevisionError } from '../src/domain/errors.js';
import type { MissionStore } from '../src/store/store.js';
import type { MissionSnapshot } from '../src/domain/types.js';
import { SCHEMA_VERSION } from '../src/domain/types.js';

function makeSnapshot(id: string): MissionSnapshot {
  const ts = new Date().toISOString();
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    status: 'draft',
    definition: null,
    approvedDefinitionRevision: null,
    approvedAt: null,
    featureAttempts: [],
    validationRounds: [],
    orchestratorDecisions: [],
    activeInvocations: [],
    redirects: [],
    pauseReason: null,
    blockReason: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

function runStoreContract(createStore: () => MissionStore) {
  let store: MissionStore;

  beforeEach(() => {
    store = createStore();
  });

  it('creates and gets a snapshot', () => {
    const snapshot = makeSnapshot('m1');
    const created = store.create(snapshot, []);
    expect(created.id).toBe('m1');
    expect(created.revision).toBe(0);
    const got = store.get('m1');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('m1');
  });

  it('returns null for missing mission', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('commit with correct revision increments revision', () => {
    const snapshot = makeSnapshot('m2');
    store.create(snapshot, []);
    const updated = store.commit({
      id: 'm2',
      expectedRevision: 0,
      snapshot: { ...snapshot, status: 'ready' },
      events: [{ type: 'test.event', payload: { x: 1 } }],
    });
    expect(updated.revision).toBe(1);
    expect(updated.status).toBe('ready');
  });

  it('throws StaleRevisionError on stale commit', () => {
    const snapshot = makeSnapshot('m3');
    store.create(snapshot, []);
    store.commit({
      id: 'm3',
      expectedRevision: 0,
      snapshot: { ...snapshot, status: 'ready' },
      events: [],
    });
    expect(() =>
      store.commit({
        id: 'm3',
        expectedRevision: 0,
        snapshot: { ...snapshot, status: 'running' },
        events: [],
      }),
    ).toThrow(StaleRevisionError);
  });

  it('stores events with monotonic sequence numbers', () => {
    const snapshot = makeSnapshot('m4');
    store.create(snapshot, [{ type: 'ev1', payload: {} }]);
    store.commit({
      id: 'm4',
      expectedRevision: 0,
      snapshot: { ...snapshot, status: 'ready' },
      events: [{ type: 'ev2', payload: {} }, { type: 'ev3', payload: {} }],
    });
    const events = store.listEvents('m4');
    expect(events.length).toBe(3);
    expect(events[0]!.sequence).toBe(1);
    expect(events[1]!.sequence).toBe(2);
    expect(events[2]!.sequence).toBe(3);
    expect(events[0]!.type).toBe('ev1');
    expect(events[1]!.type).toBe('ev2');
    expect(events[2]!.type).toBe('ev3');
  });

  it('listEvents with afterSequence filters correctly', () => {
    const snapshot = makeSnapshot('m5');
    store.create(snapshot, [{ type: 'ev1', payload: {} }]);
    store.commit({
      id: 'm5',
      expectedRevision: 0,
      snapshot: { ...snapshot },
      events: [{ type: 'ev2', payload: {} }, { type: 'ev3', payload: {} }],
    });
    const events = store.listEvents('m5', 1);
    expect(events.length).toBe(2);
    expect(events[0]!.sequence).toBe(2);
    expect(events[1]!.sequence).toBe(3);
  });

  it('persists snapshot fields correctly through commit', () => {
    const snapshot = makeSnapshot('m6');
    store.create(snapshot, []);
    const updated = { ...snapshot, status: 'running' as const, pauseReason: null };
    const committed = store.commit({ id: 'm6', expectedRevision: 0, snapshot: updated, events: [] });
    const loaded = store.get('m6')!;
    expect(loaded.status).toBe('running');
    expect(loaded.revision).toBe(1);
    expect(committed.revision).toBe(1);
  });

  it('returns empty events list for unknown mission', () => {
    expect(store.listEvents('unknown')).toEqual([]);
  });

  it('mutating the returned snapshot does not affect stored state', () => {
    const snapshot = makeSnapshot('m-iso1');
    store.create(snapshot, []);
    const got = store.get('m-iso1')!;
    got.status = 'completed';
    const reloaded = store.get('m-iso1')!;
    expect(reloaded.status).toBe('draft');
  });

  it('mutating the input snapshot does not affect stored state', () => {
    const snapshot = makeSnapshot('m-iso2');
    const created = store.create(snapshot, []);
    snapshot.status = 'completed';
    const got = store.get('m-iso2')!;
    expect(got.status).toBe('draft');
    expect(created.status).toBe('draft');
  });

  it('commit with wrong expectedRevision throws StaleRevisionError (compare-and-swap)', () => {
    const snapshot = makeSnapshot('m-cas1');
    store.create(snapshot, []);
    // Commit once to advance revision to 1.
    store.commit({ id: 'm-cas1', expectedRevision: 0, snapshot: { ...snapshot, status: 'ready' }, events: [] });
    // Attempt to commit again with stale expectedRevision:0 must fail.
    expect(() =>
      store.commit({ id: 'm-cas1', expectedRevision: 0, snapshot: { ...snapshot, status: 'running' }, events: [] }),
    ).toThrow(StaleRevisionError);
    // Stored revision should still be 1.
    expect(store.get('m-cas1')!.revision).toBe(1);
  });
}

describe('InMemoryMissionStore', () => runStoreContract(() => new InMemoryMissionStore()));

const nodeMajor = parseInt(process.versions.node.split('.')[0]!, 10);
type DatabaseSyncCtor = new (path: string) => import('node:sqlite').DatabaseSync;

let DatabaseSyncClass: DatabaseSyncCtor | null = null;
if (nodeMajor >= 22) {
  try {
    const mod = await import('node:sqlite');
    DatabaseSyncClass = mod.DatabaseSync;
  } catch {
    DatabaseSyncClass = null;
  }
}

if (DatabaseSyncClass) {
  const Ctor = DatabaseSyncClass;
  describe('SqliteMissionStore', () => runStoreContract(() => new SqliteMissionStore(new Ctor(':memory:'))));
} else {
  describe('SqliteMissionStore', () => {
    it.skip(`requires Node >= 22 for node:sqlite (current: ${process.versions.node})`, () => {});
  });
}
