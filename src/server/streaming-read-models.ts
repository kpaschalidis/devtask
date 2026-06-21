import type { DevtaskPaths } from "../infra/paths.js";
import { readSessionDetail, readWorkDetail, readWorkList, readWorkRuns } from "./read-models.js";

export interface WorkStreamSnapshot {
  work: ReturnType<typeof readWorkList>["work"];
}

export interface WorkDetailStreamSnapshot {
  detail: ReturnType<typeof readWorkDetail>;
  runs: ReturnType<typeof readWorkRuns>;
}

export interface SessionStreamSnapshot {
  thread: ReturnType<typeof readSessionDetail>["thread"];
  timeline: ReturnType<typeof readSessionDetail>["timeline"];
}

export function readWorkStreamSnapshot(paths: DevtaskPaths): WorkStreamSnapshot {
  const payload = readWorkList(paths);
  return {
    work: payload.work,
  };
}

export function readWorkDetailStreamSnapshot(paths: DevtaskPaths, workId: string): WorkDetailStreamSnapshot {
  return {
    detail: readWorkDetail(paths, workId),
    runs: readWorkRuns(paths, workId),
  };
}

export function readSessionStreamSnapshot(paths: DevtaskPaths, threadId: string): SessionStreamSnapshot {
  const detail = readSessionDetail(paths, threadId);
  return {
    thread: detail.thread,
    timeline: detail.timeline,
  };
}
