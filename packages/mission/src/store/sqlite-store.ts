import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MissionSnapshot } from '../domain/types.js';
import { StaleRevisionError } from '../domain/errors.js';
import type { MissionStore, NewMissionEvent, MissionEvent, MissionCommit } from './store.js';

interface MissionRow {
  id: string;
  schema_version: number;
  revision: number;
  status: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  mission_id: string;
  sequence: number;
  occurred_at: string;
  type: string;
  payload_json: string;
}

export class SqliteMissionStore implements MissionStore {
  private savepointSeq = 0;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mission_events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(mission_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_mission_events_mission_seq
        ON mission_events(mission_id, sequence);
    `);
  }

  create(snapshot: MissionSnapshot, events: NewMissionEvent[]): MissionSnapshot {
    const stored = { ...snapshot, revision: 0 };
    const now = new Date().toISOString();
    this.runAtomic(() => {
      this.db.prepare(`
        INSERT INTO missions (id, schema_version, revision, status, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(stored.id, stored.schemaVersion, 0, stored.status, JSON.stringify(stored), stored.createdAt || now, stored.updatedAt || now);
      this.insertEvents(stored.id, events);
    });
    return stored;
  }

  get(id: string): MissionSnapshot | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined;
    if (!row) return null;
    return JSON.parse(row.snapshot_json) as MissionSnapshot;
  }

  commit(input: MissionCommit): MissionSnapshot {
    const newRevision = input.expectedRevision + 1;
    const stored = { ...input.snapshot, revision: newRevision };
    const now = new Date().toISOString();

    this.runAtomic(() => {
      // Revision check and update are inside the same transaction.
      const result = this.db.prepare(`
        UPDATE missions SET revision = ?, status = ?, snapshot_json = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(newRevision, stored.status, JSON.stringify(stored), now, input.id, input.expectedRevision);

      if ((result as { changes: number }).changes !== 1) {
        const row = this.db.prepare('SELECT revision FROM missions WHERE id = ?').get(input.id) as { revision: number } | undefined;
        const actual = row?.revision ?? -1;
        throw new StaleRevisionError(input.id, input.expectedRevision, actual);
      }

      this.insertEvents(input.id, input.events);
    });

    return stored;
  }

  listEvents(id: string, afterSequence?: number): MissionEvent[] {
    const rows = afterSequence === undefined
      ? this.db.prepare('SELECT * FROM mission_events WHERE mission_id = ? ORDER BY sequence').all(id) as unknown as EventRow[]
      : this.db.prepare('SELECT * FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence').all(id, afterSequence) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  private insertEvents(missionId: string, events: NewMissionEvent[]): void {
    if (events.length === 0) return;
    const maxSeqRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM mission_events WHERE mission_id = ?')
      .get(missionId) as { max_seq: number };
    let seq = maxSeqRow.max_seq;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO mission_events (id, mission_id, sequence, occurred_at, type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ev of events) {
      seq += 1;
      stmt.run(crypto.randomUUID(), missionId, seq, now, ev.type, JSON.stringify(ev.payload));
    }
  }

  private runAtomic<T>(fn: () => T): T {
    const name = `mission_${++this.savepointSeq}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }
}

function rowToEvent(row: EventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
