import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DevtaskPaths } from "../infra/paths.js";
import { SqliteSessionHistoryStore } from "@devtask/agent-kernel";
import type {
  SessionHistoryEvent,
  SessionThread,
  TimelineBlock,
  TranscriptMessage,
} from "@devtask/agent-kernel";

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

export function listSessionTranscript(paths: DevtaskPaths, threadId: string): TranscriptMessage[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  const thread = getSessionThread(paths, threadId);
  if (!thread) {
    return [];
  }
  return buildTranscriptFromEvents(thread, listSessionEvents(paths, threadId));
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

function buildTranscriptFromEvents(
  thread: WorkSessionThreadSummary,
  events: SessionHistoryEvent[],
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let assistantContent = "";
  let assistantStartedAt: string | null = null;

  const flushAssistant = (createdAt: string, open = false) => {
    if (!assistantContent) return;
    messages.push({
      id: `${thread.threadId}:assistant:${messages.length}`,
      owner: thread.owner,
      labels: thread.labels,
      role: "agent",
      kind: "output",
      content: assistantContent,
      createdAt: assistantStartedAt ?? createdAt,
      ...(open ? {} : { deliveredAt: createdAt }),
    });
    assistantContent = "";
    assistantStartedAt = null;
  };

  for (const event of events) {
    if (event.visibility === "hidden") continue;
    if (event.type === "message.sent" && event.payload["role"] === "user") {
      flushAssistant(event.occurredAt);
      messages.push({
        id: event.id,
        owner: thread.owner,
        labels: thread.labels,
        role: "user",
        kind: stringKind(event.payload["kind"]) ?? "user-initiated",
        content: String(event.payload["text"] ?? ""),
        createdAt: event.occurredAt,
      });
      continue;
    }

    if (event.type === "message.delta" && event.payload["role"] === "assistant") {
      assistantStartedAt ??= event.occurredAt;
      assistantContent += String(event.payload["text"] ?? "");
      continue;
    }

    if (
      event.type === "message.completed" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed"
    ) {
      flushAssistant(event.occurredAt);
      continue;
    }

    if (event.type === "human_input.requested") {
      flushAssistant(event.occurredAt);
      messages.push({
        id: event.id,
        owner: thread.owner,
        labels: thread.labels,
        role: "agent",
        kind: "question",
        content: String(event.payload["prompt"] ?? event.payload["question"] ?? ""),
        createdAt: event.occurredAt,
      });
    }
  }

  flushAssistant(thread.endedAt ?? new Date().toISOString(), true);
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function stringKind(value: unknown): TranscriptMessage["kind"] | null {
  return value === "output" ||
    value === "thinking" ||
    value === "question" ||
    value === "answer" ||
    value === "user-initiated"
    ? value
    : null;
}
