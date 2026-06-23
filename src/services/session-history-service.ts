import type { DevtaskPaths } from "../infra/paths.js";
import {
  hasSessionHistory,
  getKernelSessionThread,
  listKernelSessionEvents,
  listKernelSessionThreads,
  listKernelSessionTimeline,
  listKernelSessionTranscript,
  type SessionHistoryEvent,
  type SessionThread,
  type TimelineBlock,
  type TranscriptMessage,
} from "../adapters/agent-kernel/session-history.js";

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
  return listKernelSessionThreads(paths, { rootOwner: { type: "work", id: workId } })
    .map(toThreadSummary)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function getSessionThread(paths: DevtaskPaths, threadId: string): WorkSessionThreadSummary | null {
  if (!hasSessionHistory(paths)) {
    return null;
  }
  const thread = getKernelSessionThread(paths, threadId);
  return thread ? toThreadSummary(thread) : null;
}

export function listSessionEvents(paths: DevtaskPaths, threadId: string, fromSeq?: number): SessionHistoryEvent[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return listKernelSessionEvents(paths, threadId, fromSeq);
}

export function listSessionTimeline(paths: DevtaskPaths, threadId: string): TimelineBlock[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return listKernelSessionTimeline(paths, threadId);
}

export function listSessionTranscript(paths: DevtaskPaths, threadId: string): TranscriptMessage[] {
  if (!hasSessionHistory(paths)) {
    return [];
  }
  return listKernelSessionTranscript(paths, threadId);
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
