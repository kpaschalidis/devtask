import { DatabaseSync } from 'node:sqlite';
import type { DomainEvent } from './domain-events.js';
import type { EventStore } from './store.js';

export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;
  private readonly stmtInsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtHistory: ReturnType<DatabaseSync['prepare']>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id  TEXT    NOT NULL,
        kind     TEXT    NOT NULL,
        payload  TEXT    NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_id ON events (work_id);
    `);
    this.stmtInsert = this.db.prepare(
      'INSERT INTO events (work_id, kind, payload, ts) VALUES (?, ?, ?, ?)',
    );
    this.stmtHistory = this.db.prepare(
      'SELECT payload FROM events WHERE work_id = ? ORDER BY id',
    );
  }

  append(event: DomainEvent): void {
    this.stmtInsert.run(event.workId, event.kind, JSON.stringify(event), event.ts);
  }

  history(workId: string): DomainEvent[] {
    return (this.stmtHistory.all(workId) as { payload: string }[])
      .map((r) => JSON.parse(r.payload) as DomainEvent);
  }

  close(): void {
    this.db.close();
  }
}
