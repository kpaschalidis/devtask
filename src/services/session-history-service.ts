import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DevtaskPaths } from "../infra/paths.js";
import { SqliteSessionHistoryStore } from "../kernel/storage/sqlite/session-history-store.js";
import type { SessionHistoryEvent, SessionThread, TimelineBlock } from "../kernel/trace/session-history.js";

export interface WorkSessionThreadSummary {
  threadId: string;
  owner: SessionThread["owner"];
  labels: SessionThread["labels"];
  agentName: string;
  status: SessionThread["status"];
  currentRuntimeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown>;
}

export function listWorkSessionThreads(paths: DevtaskPaths, workId: string): WorkSessionThreadSummary[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return withSessionHistoryStore(paths, (store) =>
    store
      .listThreads({ rootOwner: { type: "work", id: workId } })
      .map(toThreadSummary)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
  );
}

export function getSessionThread(paths: DevtaskPaths, threadId: string): WorkSessionThreadSummary | null {
  if (!hasSessionHistory(paths)) {
    return null;
  }
  return withSessionHistoryStore(paths, (store) => {
    const thread = store.getThread(threadId);
    return thread ? toThreadSummary(thread) : null;
  });
}

export function listSessionEvents(paths: DevtaskPaths, threadId: string, fromSeq?: number): SessionHistoryEvent[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return withSessionHistoryStore(paths, (store) => store.listEvents(threadId, fromSeq));
}

export function listSessionTimeline(paths: DevtaskPaths, threadId: string): TimelineBlock[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return withSessionHistoryStore(paths, (store) => store.listTimeline(threadId));
}

function toThreadSummary(thread: SessionThread): WorkSessionThreadSummary {
  return {
    threadId: thread.id,
    owner: thread.owner,
    labels: thread.labels,
    agentName: thread.agentName,
    status: thread.status,
    currentRuntimeSessionId: thread.currentRuntimeSessionId,
    startedAt: thread.startedAt,
    endedAt: thread.endedAt,
    metadata: thread.metadata,
  };
}

function withSessionHistoryStore<T>(paths: DevtaskPaths, fn: (store: SqliteSessionHistoryStore) => T): T {
  const dbPath = sessionHistoryPath(paths);
  const db = new DatabaseSync(dbPath);
  try {
    return fn(new SqliteSessionHistoryStore(db));
  } finally {
    db.close();
  }
}

function hasSessionHistory(paths: DevtaskPaths): boolean {
  return fs.existsSync(sessionHistoryPath(paths));
}

function sessionHistoryPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "kernel", "session-history.sqlite");
}
