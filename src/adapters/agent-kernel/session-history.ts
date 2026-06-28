import fs from "node:fs";
import path from "node:path";
import { buildTranscript, openPersistentSessionHistoryStore } from "@devtask/agent-kernel";
import type {
  SessionHistoryEvent,
  SessionHistoryStore,
  SessionThread,
  SessionThreadQuery,
  TimelineBlock,
  TranscriptMessage,
} from "@devtask/agent-kernel";
import type { DevtaskPaths } from "../../infra/paths.js";

export type { SessionHistoryEvent, SessionThread, TimelineBlock, TranscriptMessage };

export function sessionHistoryPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "kernel", "session-history.sqlite");
}

export function hasSessionHistory(paths: DevtaskPaths): boolean {
  const sqlitePath = sessionHistoryPath(paths);
  const filePath = sqlitePath.replace(/\.sqlite$/, ".json");
  return fs.existsSync(sqlitePath) || fs.existsSync(filePath);
}

export function listKernelSessionThreads(
  paths: DevtaskPaths,
  query: SessionThreadQuery = {},
): SessionThread[] {
  return readSessionHistory(paths, (store) => store.listThreads(query));
}

export function getKernelSessionThread(paths: DevtaskPaths, threadId: string): SessionThread | null {
  return readSessionHistory(paths, (store) => store.getThread(threadId));
}

export function listKernelSessionEvents(
  paths: DevtaskPaths,
  threadId: string,
  fromSeq?: number,
): SessionHistoryEvent[] {
  return readSessionHistory(paths, (store) => store.listEvents(threadId, fromSeq));
}

export function listKernelSessionTimeline(paths: DevtaskPaths, threadId: string): TimelineBlock[] {
  return readSessionHistory(paths, (store) => store.listTimeline(threadId));
}

export function listKernelSessionTranscript(paths: DevtaskPaths, threadId: string): TranscriptMessage[] {
  return readSessionHistory(paths, (store) => {
    const thread = store.getThread(threadId);
    if (!thread) return [];
    return buildTranscript(
      [thread],
      (id) => store.listEvents(id),
      () => null,
    );
  });
}

function readSessionHistory<T>(paths: DevtaskPaths, fn: (store: SessionHistoryStore) => T): T {
  const dbPath = sessionHistoryPath(paths);
  const handle = openPersistentSessionHistoryStore(dbPath);
  try {
    return fn(handle.store);
  } finally {
    handle.close();
  }
}
