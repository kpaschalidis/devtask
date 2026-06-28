import crypto from 'node:crypto';
import type {
  NewSessionHistoryEvent,
  SessionLabels,
  SessionHistoryEvent,
  SessionHistoryEventCategory,
  SessionHistoryEventSource,
  SessionOwner,
  SessionOwnerRef,
  SessionThread,
  SessionThreadQuery,
  SessionThreadStatus,
  TimelineBlock,
  TranscriptMessage,
} from '../../trace/session-history.js';
import type { SessionHistoryStore } from '../../trace/session-history-store.js';
import { now } from '../../shared/time.js';
import { buildTimelineBlocks, buildTranscript } from '../../trace/history-projection.js';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface ThreadRow {
  id: string;
  owner_type: string;
  owner_id: string;
  parent_owner_type: string | null;
  parent_owner_id: string | null;
  labels_json: string;
  agent_name: string;
  status: string;
  current_runtime_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  metadata_json: string;
}

interface EventRow {
  id: string;
  thread_id: string;
  seq: number;
  occurred_at: string;
  source: string;
  category: string;
  type: string;
  turn_id: string | null;
  item_id: string | null;
  parent_item_id: string | null;
  runtime_session_id: string | null;
  visibility: string;
  payload_json: string;
}

interface TimelineBlockRow {
  id: string;
  thread_id: string;
  block_seq: number;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  title: string | null;
  body_text: string;
  metadata_json: string;
}

export class SqliteSessionHistoryStore implements SessionHistoryStore {
  private savepointSeq = 0;

  constructor(private readonly db: SqliteDatabaseLike) {
    this.ensureThreadSchema();
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_history_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT,
        parent_item_id TEXT,
        runtime_session_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'visible',
        payload_json TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_thread_seq
        ON session_history_events(thread_id, seq);
      CREATE INDEX IF NOT EXISTS idx_session_events_type
        ON session_history_events(type, occurred_at);
      CREATE TABLE IF NOT EXISTS session_timeline_blocks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        block_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        title TEXT,
        body_text TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(thread_id, block_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_timeline_thread
        ON session_timeline_blocks(thread_id, block_seq);

      CREATE TABLE IF NOT EXISTS session_delivered_messages (
        message_id TEXT PRIMARY KEY,
        delivered_at TEXT NOT NULL
      );
    `);
    this.ensureEventColumn('item_id', 'TEXT');
    this.ensureEventColumn('parent_item_id', 'TEXT');
    this.ensureEventColumn('visibility', "TEXT NOT NULL DEFAULT 'visible'");
    this.ensureThreadIndexes();
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_events_item
        ON session_history_events(thread_id, item_id);
    `);
  }

  createThread(thread: SessionThread): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO session_threads
        (id, owner_type, owner_id, parent_owner_type, parent_owner_id, labels_json, agent_name, status, current_runtime_session_id, started_at, ended_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      thread.owner.type,
      thread.owner.id,
      thread.owner.parent?.type ?? null,
      thread.owner.parent?.id ?? null,
      JSON.stringify(thread.labels),
      thread.agentName,
      thread.status,
      thread.currentRuntimeSessionId,
      thread.startedAt,
      thread.endedAt,
      JSON.stringify(thread.metadata),
    );
  }

  updateThread(thread: SessionThread): void {
    this.db.prepare(`
      UPDATE session_threads
      SET owner_type = ?, owner_id = ?, parent_owner_type = ?, parent_owner_id = ?, labels_json = ?, agent_name = ?, status = ?,
          current_runtime_session_id = ?, started_at = ?, ended_at = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      thread.owner.type,
      thread.owner.id,
      thread.owner.parent?.type ?? null,
      thread.owner.parent?.id ?? null,
      JSON.stringify(thread.labels),
      thread.agentName,
      thread.status,
      thread.currentRuntimeSessionId,
      thread.startedAt,
      thread.endedAt,
      JSON.stringify(thread.metadata),
      thread.id,
    );
  }

  getThread(id: string): SessionThread | null {
    const row = this.db.prepare('SELECT * FROM session_threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? rowToThread(row) : null;
  }

  getActiveThread(owner: SessionOwner, labels: SessionLabels = {}): SessionThread | null {
    return this.listThreads({
      owner: { type: owner.type, id: owner.id },
      labels,
      status: 'active',
    }).find((thread) => sameOwner(thread.owner, owner)) ?? null;
  }

  listThreads(query: SessionThreadQuery = {}): SessionThread[] {
    return (this.db.prepare('SELECT * FROM session_threads ORDER BY started_at').all() as unknown as ThreadRow[])
      .map(rowToThread)
      .filter((thread) => matchesThreadQuery(thread, query));
  }

  appendEvent(input: NewSessionHistoryEvent): SessionHistoryEvent {
    const id = crypto.randomUUID();
    const occurredAt = input.occurredAt ?? now();
    let seq = 0;
    this.runAtomic(() => {
      const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM session_history_events WHERE thread_id = ?')
        .get(input.threadId) as { next: number };
      seq = next.next;
      this.db.prepare(`
        INSERT INTO session_history_events
          (id, thread_id, seq, occurred_at, source, category, type, turn_id, item_id, parent_item_id, runtime_session_id, visibility, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        seq,
        occurredAt,
        input.source,
        input.category,
        input.type,
        input.turnId ?? null,
        input.itemId ?? null,
        input.parentItemId ?? null,
        input.runtimeSessionId ?? null,
        input.visibility ?? 'visible',
        JSON.stringify(input.payload ?? {}),
      );
    });
    return {
      id,
      threadId: input.threadId,
      seq,
      occurredAt,
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
  }

  listEvents(threadId: string, fromSeq?: number): SessionHistoryEvent[] {
    const rows = fromSeq === undefined
      ? this.db.prepare('SELECT * FROM session_history_events WHERE thread_id = ? ORDER BY seq').all(threadId) as unknown as EventRow[]
      : this.db.prepare('SELECT * FROM session_history_events WHERE thread_id = ? AND seq >= ? ORDER BY seq').all(threadId, fromSeq) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  deleteThreads(query: SessionThreadQuery): void {
    const threadIds = this.listThreads(query).map((thread) => thread.id);
    this.runAtomic(() => {
      for (const threadId of threadIds) {
        this.db.prepare('DELETE FROM session_timeline_blocks WHERE thread_id = ?').run(threadId);
        this.db.prepare('DELETE FROM session_history_events WHERE thread_id = ?').run(threadId);
      }
      for (const threadId of threadIds) {
        this.db.prepare('DELETE FROM session_threads WHERE id = ?').run(threadId);
      }
    });
  }

  listTranscript(query: SessionThreadQuery): TranscriptMessage[] {
    return buildTranscript(
      this.listThreads(query),
      (threadId) => this.listEvents(threadId),
      (messageId) => this.getDeliveredAt(messageId),
    );
  }

  getUndeliveredUserMessages(query: SessionThreadQuery): TranscriptMessage[] {
    return this.listTranscript(query)
      .filter((message) => message.role === 'user' && message.kind === 'user-initiated' && !message.deliveredAt);
  }

  markDelivered(messageIds: string[]): void {
    const ts = now();
    const stmt = this.db.prepare('INSERT OR REPLACE INTO session_delivered_messages (message_id, delivered_at) VALUES (?, ?)');
    this.runAtomic(() => {
      for (const id of messageIds) stmt.run(id, ts);
    });
  }

  rebuildTimeline(threadId: string): void {
    const events = this.listEvents(threadId);
    const blocks = buildTimelineBlocks(threadId, events);
    const stmt = this.db.prepare(`
      INSERT INTO session_timeline_blocks
        (id, thread_id, block_seq, kind, status, started_at, ended_at, title, body_text, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.runAtomic(() => {
      this.db.prepare('DELETE FROM session_timeline_blocks WHERE thread_id = ?').run(threadId);
      for (const block of blocks) {
        stmt.run(
          block.id,
          block.threadId,
          block.blockSeq,
          block.kind,
          block.status,
          block.startedAt,
          block.endedAt,
          block.title,
          block.bodyText,
          JSON.stringify(block.metadata),
        );
      }
    });
  }

  listTimeline(threadId: string): TimelineBlock[] {
    return (this.db.prepare('SELECT * FROM session_timeline_blocks WHERE thread_id = ? ORDER BY block_seq').all(threadId) as unknown as TimelineBlockRow[])
      .map(rowToTimelineBlock);
  }

  private getDeliveredAt(messageId: string): string | null {
    const row = this.db.prepare('SELECT delivered_at FROM session_delivered_messages WHERE message_id = ?')
      .get(messageId) as { delivered_at: string } | undefined;
    return row?.delivered_at ?? null;
  }

  private runAtomic<T>(fn: () => T): T {
    const name = `session_history_${++this.savepointSeq}`;
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

  private ensureEventColumn(name: string, definition: string): void {
    const rows = this.db.prepare('PRAGMA table_info(session_history_events)').all() as unknown as Array<{ name: string }>;
    if (rows.some((row) => row.name === name)) return;
    this.db.exec(`ALTER TABLE session_history_events ADD COLUMN ${name} ${definition}`);
  }

  private ensureThreadSchema(): void {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'session_threads'
    `).get() as { name: string } | undefined;

    if (!row) {
      this.db.exec(`
        CREATE TABLE session_threads (
          id TEXT PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          parent_owner_type TEXT,
          parent_owner_id TEXT,
          labels_json TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          status TEXT NOT NULL,
          current_runtime_session_id TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          metadata_json TEXT NOT NULL
        );
      `);
      return;
    }

    const columns = this.db.prepare('PRAGMA table_info(session_threads)').all() as unknown as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'owner_type')) return;

    this.runAtomic(() => {
      this.db.exec('DROP TABLE IF EXISTS session_timeline_blocks');
      this.db.exec('DROP TABLE IF EXISTS session_history_events');
      this.db.exec('DROP TABLE IF EXISTS session_delivered_messages');
      this.db.exec('DROP TABLE session_threads');
      this.db.exec(`
        CREATE TABLE session_threads (
          id TEXT PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          parent_owner_type TEXT,
          parent_owner_id TEXT,
          labels_json TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          status TEXT NOT NULL,
          current_runtime_session_id TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          metadata_json TEXT NOT NULL
        );
      `);
    });
  }

  private ensureThreadIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_threads_owner
        ON session_threads(owner_type, owner_id, status);
      CREATE INDEX IF NOT EXISTS idx_session_threads_parent_owner
        ON session_threads(parent_owner_type, parent_owner_id, status);
    `);
  }
}

function rowToThread(row: ThreadRow): SessionThread {
  return {
    id: row.id,
    owner: {
      type: row.owner_type,
      id: row.owner_id,
      parent: row.parent_owner_type && row.parent_owner_id
        ? { type: row.parent_owner_type, id: row.parent_owner_id }
        : null,
    },
    labels: JSON.parse(row.labels_json) as SessionLabels,
    agentName: row.agent_name,
    status: row.status as SessionThreadStatus,
    currentRuntimeSessionId: row.current_runtime_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

function rowToEvent(row: EventRow): SessionHistoryEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    occurredAt: row.occurred_at,
    source: row.source as SessionHistoryEventSource,
    category: row.category as SessionHistoryEventCategory,
    type: row.type,
    turnId: row.turn_id,
    itemId: row.item_id ?? null,
    parentItemId: row.parent_item_id ?? null,
    runtimeSessionId: row.runtime_session_id,
    visibility: row.visibility === 'hidden' ? 'hidden' : 'visible',
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function rowToTimelineBlock(row: TimelineBlockRow): TimelineBlock {
  return {
    id: row.id,
    threadId: row.thread_id,
    blockSeq: row.block_seq,
    kind: row.kind as TimelineBlock['kind'],
    status: row.status as TimelineBlock['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    title: row.title,
    bodyText: row.body_text,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

function matchesThreadQuery(thread: SessionThread, query: SessionThreadQuery): boolean {
  if (query.owner && !sameOwnerRef(thread.owner, query.owner)) return false;
  if (query.rootOwner && !matchesRootOwner(thread.owner, query.rootOwner)) return false;
  if (query.status && thread.status !== query.status) return false;
  if (query.labels && !hasLabels(thread.labels, query.labels)) return false;
  return true;
}

function sameOwner(owner: SessionOwner, other: SessionOwner): boolean {
  return sameOwnerRef(owner, other) && sameOwnerRef(owner.parent, other.parent);
}

function sameOwnerRef(owner: SessionOwnerRef | null, other: SessionOwnerRef | null): boolean {
  if (!owner && !other) return true;
  if (!owner || !other) return false;
  return owner.type === other.type && owner.id === other.id;
}

function matchesRootOwner(owner: SessionOwner, root: SessionOwnerRef): boolean {
  return sameOwnerRef(owner, root) || sameOwnerRef(owner.parent, root);
}

function hasLabels(labels: SessionLabels, expected: SessionLabels): boolean {
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}
