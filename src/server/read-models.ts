import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { workItemGraphSnapshotPath } from "../infra/paths.js";
import { listWorkItems, type WorkItem } from "../storage/work-store.js";
import { getWorkStatus } from "../services/work-status-service.js";
import { getWorkDiagnostics } from "../services/work-diagnostics-service.js";
import { inspectWork } from "../services/work-inspection-service.js";
import { getLatestWorkPhaseRun, listWorkPhaseRuns, listWorkPhaseSessions } from "../services/session-run-service.js";
import {
  getSessionThread,
  listSessionEvents,
  listSessionTranscript,
  listSessionTimeline,
  listWorkSessionThreads,
} from "../services/session-history-service.js";
import { type WorkGraph, readMaterializedWorkGraph, readWorkGraph } from "../work-materializer.js";

export interface WorkListEntry {
  id: string;
  title: string;
  sourceType: WorkItem["source"]["type"];
  status: string;
  updatedAt: string;
  nextAction: string;
  waitingOn: string;
}

export interface WorkListResponse {
  workspaceId: string | null;
  workspaceName: string | null;
  work: WorkListEntry[];
  generatedAt: string;
}

export interface WorkDetail {
  item: WorkItem;
  status: ReturnType<typeof getWorkStatus>;
  diagnostics: ReturnType<typeof getWorkDiagnostics>;
  inspection: ReturnType<typeof inspectWork>;
  sessions: ReturnType<typeof listWorkSessionThreads>;
  graph: WorkGraph | null;
}

export function readWorkList(paths: DevtaskPaths): WorkListResponse {
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
    workspaceId: paths.workspaceId,
    workspaceName: paths.workspaceId ? path.basename(paths.root) : null,
    work,
    generatedAt: new Date().toISOString(),
  };
}

function readWorkDetailGraph(paths: DevtaskPaths, workId: string): WorkGraph | null {
  try {
    const snapshotPath = workItemGraphSnapshotPath(paths, workId);
    if (fs.existsSync(snapshotPath)) return readMaterializedWorkGraph(paths, workId);
    return readWorkGraph(paths, workId);
  } catch {
    return null;
  }
}

export function readWorkDetail(paths: DevtaskPaths, workId: string): WorkDetail {
  return {
    item: listWorkItems(paths).find((item) => item.id === workId) ?? (() => { throw new Error(`Work item ${workId} does not exist`); })(),
    status: getWorkStatus(paths, workId),
    diagnostics: getWorkDiagnostics(paths, workId),
    inspection: inspectWork(paths, workId),
    sessions: listWorkSessionThreads(paths, workId),
    graph: readWorkDetailGraph(paths, workId),
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
  transcript: ReturnType<typeof listSessionTranscript>;
} {
  return {
    thread: getSessionThread(paths, threadId),
    events: listSessionEvents(paths, threadId, fromSeq),
    timeline: listSessionTimeline(paths, threadId),
    transcript: listSessionTranscript(paths, threadId),
  };
}
