import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredWorkflowEvent, WorkflowEvent } from "./events.js";
import type { WorkflowEventStore } from "./event-store.js";

export class SqliteWorkflowEventStore implements WorkflowEventStore {
  private readonly db: DatabaseSync;
  private readonly insert: ReturnType<DatabaseSync["prepare"]>;
  private readonly selectHistory: ReturnType<DatabaseSync["prepare"]>;
  private readonly selectAll: ReturnType<DatabaseSync["prepare"]>;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        recorded_at TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_entity_id ON workflow_events (entity_id);
    `);
    this.insert = this.db.prepare(
      "INSERT INTO workflow_events (entity_id, kind, payload, recorded_at) VALUES (?, ?, ?, ?)"
    );
    this.selectHistory = this.db.prepare(
      "SELECT sequence, entity_id, kind, payload, recorded_at FROM workflow_events WHERE entity_id = ? ORDER BY sequence"
    );
    this.selectAll = this.db.prepare(
      "SELECT sequence, entity_id, kind, payload, recorded_at FROM workflow_events ORDER BY sequence"
    );
  }

  append(event: WorkflowEvent): StoredWorkflowEvent {
    const recordedAt = new Date().toISOString();
    this.insert.run(event.entityId, event.kind, JSON.stringify(event), recordedAt);
    const sequence = Number(this.db.prepare("SELECT last_insert_rowid() AS id").get()!.id);
    return {
      sequence,
      entityId: event.entityId,
      kind: event.kind,
      event,
      recordedAt
    };
  }

  history(entityId: string): StoredWorkflowEvent[] {
    return this.rowsToEvents(this.selectHistory.all(entityId));
  }

  all(): StoredWorkflowEvent[] {
    return this.rowsToEvents(this.selectAll.all());
  }

  close(): void {
    this.db.close();
  }

  private rowsToEvents(rows: unknown[]): StoredWorkflowEvent[] {
    return rows.map((value) => {
      const row = parseEventRow(value);
      return {
        sequence: row.sequence,
        entityId: row.entity_id,
        kind: row.kind as WorkflowEvent["kind"],
        event: JSON.parse(row.payload) as WorkflowEvent,
        recordedAt: row.recorded_at
      };
    });
  }
}

interface EventRow {
  sequence: number;
  entity_id: string;
  kind: string;
  payload: string;
  recorded_at: string;
}

function parseEventRow(value: unknown): EventRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid workflow event row");
  }
  const row = value as Record<string, unknown>;
  return {
    sequence: requireNumber(row.sequence, "sequence"),
    entity_id: requireString(row.entity_id, "entity_id"),
    kind: requireString(row.kind, "kind"),
    payload: requireString(row.payload, "payload"),
    recorded_at: requireString(row.recorded_at, "recorded_at")
  };
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid workflow event row: ${field} must be a number`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid workflow event row: ${field} must be a string`);
  }
  return value;
}
