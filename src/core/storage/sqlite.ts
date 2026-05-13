import { DatabaseSync } from 'node:sqlite';
import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { StageAttempt } from '../domain/stage-attempt.js';
import type { RunAttempt } from '../domain/run-attempt.js';
import type { Artifact } from '../domain/artifact.js';
import type { Gate } from '../domain/gate.js';
import type { AgentQuestion } from '../domain/agent-question.js';
import type {
  WorkStore,
  TaskStore,
  ExecutionGraphStore,
  StageAttemptStore,
  RunAttemptStore,
  ArtifactStore,
  GateStore,
  AgentQuestionStore,
} from '../ports/store.js';
import type { EngineStores } from '../engine/workflow-engine.js';

function parseJson<T>(s: string): T {
  return JSON.parse(s) as T;
}

// ---------------------------------------------------------------------------
// WorkStore
// ---------------------------------------------------------------------------

export class SqliteWorkStore implements WorkStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtActive: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS works (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL
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

export class SqliteTaskStore implements TaskStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByWork: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id       TEXT PRIMARY KEY,
        work_id  TEXT NOT NULL,
        data     TEXT NOT NULL
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

export class SqliteExecutionGraphStore implements ExecutionGraphStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByWork: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_graphs (
        id       TEXT PRIMARY KEY,
        work_id  TEXT NOT NULL UNIQUE,
        data     TEXT NOT NULL
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
// StageAttemptStore
// ---------------------------------------------------------------------------

export class SqliteStageAttemptStore implements StageAttemptStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByTask: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByWork: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtLatest: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stage_attempts (
        id        TEXT PRIMARY KEY,
        work_id   TEXT NOT NULL,
        task_id   TEXT,
        stage     TEXT NOT NULL,
        data      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stage_attempts_work ON stage_attempts (work_id);
      CREATE INDEX IF NOT EXISTS idx_stage_attempts_task ON stage_attempts (work_id, task_id);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO stage_attempts (id, work_id, task_id, stage, data) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtById = db.prepare('SELECT data FROM stage_attempts WHERE id = ?');
    this.stmtByTask = db.prepare(
      'SELECT data FROM stage_attempts WHERE work_id = ? AND task_id = ? ORDER BY rowid',
    );
    this.stmtByWork = db.prepare(
      'SELECT data FROM stage_attempts WHERE work_id = ? ORDER BY rowid',
    );
    this.stmtLatest = db.prepare(
      'SELECT data FROM stage_attempts WHERE work_id = ? AND task_id IS ? AND stage = ? ORDER BY rowid DESC LIMIT 1',
    );
  }

  save(attempt: StageAttempt): void {
    this.stmtUpsert.run(
      attempt.id,
      attempt.workId,
      attempt.taskId ?? null,
      attempt.stage,
      JSON.stringify(attempt),
    );
  }

  getById(id: string): StageAttempt | null {
    const r = this.stmtById.get(id) as { data: string } | undefined;
    return r ? parseJson<StageAttempt>(r.data) : null;
  }

  listByTask(workId: string, taskId: string): StageAttempt[] {
    return (this.stmtByTask.all(workId, taskId) as { data: string }[]).map((r) =>
      parseJson<StageAttempt>(r.data),
    );
  }

  listByWork(workId: string): StageAttempt[] {
    return (this.stmtByWork.all(workId) as { data: string }[]).map((r) =>
      parseJson<StageAttempt>(r.data),
    );
  }

  latestForStage(workId: string, taskId: string | null, stage: string): StageAttempt | null {
    const r = this.stmtLatest.get(workId, taskId, stage) as { data: string } | undefined;
    return r ? parseJson<StageAttempt>(r.data) : null;
  }
}

// ---------------------------------------------------------------------------
// RunAttemptStore
// ---------------------------------------------------------------------------

export class SqliteRunAttemptStore implements RunAttemptStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtById: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByStage: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_attempts (
        id                TEXT PRIMARY KEY,
        stage_attempt_id  TEXT NOT NULL,
        data              TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_attempts_stage ON run_attempts (stage_attempt_id);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO run_attempts (id, stage_attempt_id, data) VALUES (?, ?, ?)',
    );
    this.stmtById    = db.prepare('SELECT data FROM run_attempts WHERE id = ?');
    this.stmtByStage = db.prepare(
      'SELECT data FROM run_attempts WHERE stage_attempt_id = ? ORDER BY rowid DESC LIMIT 1',
    );
  }

  save(attempt: RunAttempt): void {
    this.stmtUpsert.run(attempt.id, attempt.stageAttemptId, JSON.stringify(attempt));
  }

  getById(id: string): RunAttempt | null {
    const r = this.stmtById.get(id) as { data: string } | undefined;
    return r ? parseJson<RunAttempt>(r.data) : null;
  }

  getByStageAttempt(stageAttemptId: string): RunAttempt | null {
    const r = this.stmtByStage.get(stageAttemptId) as { data: string } | undefined;
    return r ? parseJson<RunAttempt>(r.data) : null;
  }
}

// ---------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------

export class SqliteArtifactStore implements ArtifactStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByStage: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtByTask: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id                TEXT PRIMARY KEY,
        work_id           TEXT NOT NULL,
        task_id           TEXT,
        stage_attempt_id  TEXT NOT NULL,
        data              TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_stage ON artifacts (stage_attempt_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (work_id, task_id);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO artifacts (id, work_id, task_id, stage_attempt_id, data) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtByStage = db.prepare(
      'SELECT data FROM artifacts WHERE stage_attempt_id = ? ORDER BY rowid',
    );
    this.stmtByTask = db.prepare(
      'SELECT data FROM artifacts WHERE work_id = ? AND task_id IS ? ORDER BY rowid',
    );
  }

  save(artifact: Artifact): void {
    this.stmtUpsert.run(
      artifact.id,
      artifact.workId,
      artifact.taskId ?? null,
      artifact.stageAttemptId,
      JSON.stringify(artifact),
    );
  }

  listByStageAttempt(stageAttemptId: string): Artifact[] {
    return (this.stmtByStage.all(stageAttemptId) as { data: string }[]).map((r) =>
      parseJson<Artifact>(r.data),
    );
  }

  listByTask(workId: string, taskId: string | null): Artifact[] {
    return (this.stmtByTask.all(workId, taskId) as { data: string }[]).map((r) =>
      parseJson<Artifact>(r.data),
    );
  }
}

// ---------------------------------------------------------------------------
// GateStore
// ---------------------------------------------------------------------------

export class SqliteGateStore implements GateStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtOpenGate: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gates (
        id       TEXT PRIMARY KEY,
        work_id  TEXT NOT NULL,
        task_id  TEXT,
        stage    TEXT NOT NULL,
        data     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gates_work ON gates (work_id, task_id, stage);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO gates (id, work_id, task_id, stage, data) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtOpenGate = db.prepare(
      "SELECT data FROM gates WHERE work_id = ? AND task_id IS ? AND stage = ? AND json_extract(data, '$.closedAt') IS NULL ORDER BY rowid DESC LIMIT 1",
    );
  }

  save(gate: Gate): void {
    this.stmtUpsert.run(gate.id, gate.workId, gate.taskId ?? null, gate.stage, JSON.stringify(gate));
  }

  getOpenGate(workId: string, taskId: string | null, stage: string): Gate | null {
    const r = this.stmtOpenGate.get(workId, taskId, stage) as { data: string } | undefined;
    return r ? parseJson<Gate>(r.data) : null;
  }
}

// ---------------------------------------------------------------------------
// AgentQuestionStore
// ---------------------------------------------------------------------------

export class SqliteAgentQuestionStore implements AgentQuestionStore {
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtOpenQuestion: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_questions (
        id              TEXT PRIMARY KEY,
        run_attempt_id  TEXT NOT NULL,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_run ON agent_questions (run_attempt_id);
    `);
    this.stmtUpsert = db.prepare(
      'INSERT OR REPLACE INTO agent_questions (id, run_attempt_id, data) VALUES (?, ?, ?)',
    );
    this.stmtOpenQuestion = db.prepare(
      "SELECT data FROM agent_questions WHERE run_attempt_id = ? AND json_extract(data, '$.answeredAt') IS NULL ORDER BY rowid DESC LIMIT 1",
    );
  }

  save(question: AgentQuestion): void {
    this.stmtUpsert.run(question.id, question.runAttemptId, JSON.stringify(question));
  }

  getOpenQuestion(runAttemptId: string): AgentQuestion | null {
    const r = this.stmtOpenQuestion.get(runAttemptId) as { data: string } | undefined;
    return r ? parseJson<AgentQuestion>(r.data) : null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteStores extends EngineStores {
  close(): void;
}

export function createSqliteStores(dbPath: string): SqliteStores {
  const db = new DatabaseSync(dbPath);

  const work      = new SqliteWorkStore(db);
  const tasks     = new SqliteTaskStore(db);
  const graph     = new SqliteExecutionGraphStore(db);
  const stages    = new SqliteStageAttemptStore(db);
  const runs      = new SqliteRunAttemptStore(db);
  const artifacts = new SqliteArtifactStore(db);
  const gates     = new SqliteGateStore(db);
  const questions = new SqliteAgentQuestionStore(db);

  return {
    work,
    tasks,
    graph,
    stages,
    runs,
    artifacts,
    gates,
    questions,
    close() {
      db.close();
    },
  };
}

