import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DevtaskPaths } from "../../infra/paths.js";
import { SqliteSessionHistoryStore } from "../../kernel/storage/sqlite/session-history-store.js";
import type {
  SessionHistoryEvent,
  SessionThread,
  TimelineBlock,
  TranscriptMessage,
} from "../../kernel/trace/session-history.js";

export type { SessionHistoryEvent, SessionThread, TimelineBlock, TranscriptMessage };

export function sessionHistoryPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "kernel", "session-history.sqlite");
}

export function hasSessionHistory(paths: DevtaskPaths): boolean {
  return fs.existsSync(sessionHistoryPath(paths));
}

export function withSessionHistory<T>(paths: DevtaskPaths, fn: (store: SqliteSessionHistoryStore) => T): T {
  const dbPath = sessionHistoryPath(paths);
  const db = new DatabaseSync(dbPath);
  try {
    return fn(new SqliteSessionHistoryStore(db));
  } finally {
    db.close();
  }
}
