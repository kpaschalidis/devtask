import type { DevtaskPaths } from "../infra/paths.js";
import { listWorkItems, type WorkItem } from "../storage/work-store.js";
import { getWorkStatus } from "../services/work-status-service.js";
import { getWorkDiagnostics } from "../services/work-diagnostics-service.js";
import { inspectWork } from "../services/work-inspection-service.js";
import { getLatestWorkPhaseRun, listWorkPhaseRuns, listWorkPhaseSessions } from "../services/session-run-service.js";
import {
  getSessionThread,
  listSessionEvents,
  listSessionTimeline,
  listWorkSessionThreads,
} from "../services/session-history-service.js";

export interface WorkListEntry {
  id: string;
  title: string;
  sourceType: WorkItem["source"]["type"];
  status: string;
  updatedAt: string;
  nextAction: string;
  waitingOn: string;
}

export interface WorkDetail {
  item: WorkItem;
  status: ReturnType<typeof getWorkStatus>;
  diagnostics: ReturnType<typeof getWorkDiagnostics>;
  inspection: ReturnType<typeof inspectWork>;
  sessions: ReturnType<typeof listWorkSessionThreads>;
}

export function readWorkList(paths: DevtaskPaths): { work: WorkListEntry[]; generatedAt: string } {
  const work = listWorkItems(paths)
    .map((item) => {
      const diagnostics = getWorkDiagnostics(paths, item.id);
      return {
        id: item.id,
        title: item.source.title,
        sourceType: item.source.type,
        status: item.status,
        updatedAt: item.updatedAt,
        nextAction: diagnostics.next,
        waitingOn: diagnostics.waitingOn,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    work,
    generatedAt: new Date().toISOString(),
  };
}

export function readWorkDetail(paths: DevtaskPaths, workId: string): WorkDetail {
  return {
    item: listWorkItems(paths).find((item) => item.id === workId) ?? (() => { throw new Error(`Work item ${workId} does not exist`); })(),
    status: getWorkStatus(paths, workId),
    diagnostics: getWorkDiagnostics(paths, workId),
    inspection: inspectWork(paths, workId),
    sessions: listWorkSessionThreads(paths, workId),
  };
}

export function readWorkRuns(paths: DevtaskPaths, workId: string): {
  live: ReturnType<typeof listWorkPhaseSessions>;
  latest: ReturnType<typeof listWorkPhaseRuns>;
  orchestrate: ReturnType<typeof getLatestWorkPhaseRun>;
} {
  return {
    live: listWorkPhaseSessions(paths, workId),
    latest: listWorkPhaseRuns(paths, workId, { latest: true }),
    orchestrate: getLatestWorkPhaseRun(paths, workId, "orchestrate"),
  };
}

export function readSessionDetail(paths: DevtaskPaths, threadId: string, fromSeq?: number): {
  thread: ReturnType<typeof getSessionThread>;
  events: ReturnType<typeof listSessionEvents>;
  timeline: ReturnType<typeof listSessionTimeline>;
} {
  return {
    thread: getSessionThread(paths, threadId),
    events: listSessionEvents(paths, threadId, fromSeq),
    timeline: listSessionTimeline(paths, threadId),
  };
}
