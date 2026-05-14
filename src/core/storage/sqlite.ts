import { DatabaseSync } from 'node:sqlite';
import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { CoreStores } from '../ports/store.js';

function parseJson<T>(s: string): T {
  return JSON.parse(s) as T;
}

// ---------------------------------------------------------------------------
// WorkStore
// ---------------------------------------------------------------------------

export class SqliteWorkStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtActive: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS works (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    this.stmtUpsert = db.prepare('INSERT OR REPLACE INTO works (id, data) VALUES (?, ?)');
    this.stmtById   = db.prepare('SELECT data FROM works WHERE id = ?');
    this.stmtActive = db.prepare(
      "SELECT data FROM works WHERE json_extract(data, '$.status') NOT IN ('completed', 'failed')",
    );
  }

  save(work: Work): void {
    this.stmtUpsert.run(work.id, JSON.stringify(work));
  }

  getById(id: string): Work | null {
    const r = this.stmtById.get(id) as { data: string } | undefined;
    return r ? parseJson<Work>(r.data) : null;
  }

  listActive(): Work[] {
    return (this.stmtActive.all() as { data: string }[]).map((r) => parseJson<Work>(r.data));
  }
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export class SqliteTaskStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByWork: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id      TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        data    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_work_id ON tasks (work_id);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO tasks (id, work_id, data) VALUES (?, ?, ?)',
    );
    this.stmtById   = db.prepare('SELECT data FROM tasks WHERE id = ?');
    this.stmtByWork = db.prepare('SELECT data FROM tasks WHERE work_id = ?');
  }

  save(task: Task): void {
    this.stmtUpsert.run(task.id, task.workId, JSON.stringify(task));
  }

  getById(id: string): Task | null {
    const r = this.stmtById.get(id) as { data: string } | undefined;
    return r ? parseJson<Task>(r.data) : null;
  }

  listByWork(workId: string): Task[] {
    return (this.stmtByWork.all(workId) as { data: string }[]).map((r) => parseJson<Task>(r.data));
  }
}

// ---------------------------------------------------------------------------
// ExecutionGraphStore
// ---------------------------------------------------------------------------

export class SqliteExecutionGraphStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByWork: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_graphs (
        id      TEXT PRIMARY KEY,
        work_id TEXT NOT NULL UNIQUE,
        data    TEXT NOT NULL
      );
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO execution_graphs (id, work_id, data) VALUES (?, ?, ?)',
    );
    this.stmtByWork = db.prepare('SELECT data FROM execution_graphs WHERE work_id = ?');
  }

  save(graph: ExecutionGraph): void {
    this.stmtUpsert.run(graph.id, graph.workId, JSON.stringify(graph));
  }

  getByWork(workId: string): ExecutionGraph | null {
    const r = this.stmtByWork.get(workId) as { data: string } | undefined;
    return r ? parseJson<ExecutionGraph>(r.data) : null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteCoreStores extends CoreStores {
  close(): void;
}

export function createSqliteStores(dbPath: string): SqliteCoreStores {
  const db = new DatabaseSync(dbPath);
  const work  = new SqliteWorkStore(db);
  const tasks = new SqliteTaskStore(db);
  const graph = new SqliteExecutionGraphStore(db);

  return {
    work,
    tasks,
    graph,
    close() { db.close(); },
  };
}
