import type {
  NewSessionHistoryEvent,
  SessionHistoryEvent,
  SessionLabels,
  SessionOwner,
  SessionThreadQuery,
  SessionThread,
  TimelineBlock,
  TranscriptMessage,
} from './session-history.js';

export interface SessionHistoryStore {
  createThread(thread: SessionThread): void;
  updateThread(thread: SessionThread): void;
  getThread(id: string): SessionThread | null;
  getActiveThread(owner: SessionOwner, labels?: SessionLabels): SessionThread | null;
  listThreads(query?: SessionThreadQuery): SessionThread[];
  appendEvent(input: NewSessionHistoryEvent): SessionHistoryEvent;
  listEvents(threadId: string, fromSeq?: number): SessionHistoryEvent[];
  deleteThreads(query: SessionThreadQuery): void;

  listTranscript(query: SessionThreadQuery): TranscriptMessage[];
  getUndeliveredUserMessages(query: SessionThreadQuery): TranscriptMessage[];
  markDelivered(messageIds: string[]): void;

  rebuildTimeline(threadId: string): void;
  listTimeline(threadId: string): TimelineBlock[];
}
