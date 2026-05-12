import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { workItemDir } from "./paths.js";
import {
  readGenericStageLedger,
  recordGenericStage,
  runGenericStage,
  type GenericStageContract,
  type GenericStageLedger,
  type GenericStageStatus,
  type GenericStageUpdate
} from "./stage-ledger.js";

export const WORK_STAGE_NAMES = [
  "plan",
  "spec",
  "approve-plan",
  "repo-plan",
  "approve-spec",
  "exec",
  "run",
  "check",
  "fix",
  "review",
  "approve",
  "approve-exec",
  "commit",
  "pr",
  "ci"
] as const;

export type WorkStageName = (typeof WORK_STAGE_NAMES)[number];
export type WorkStageStatus = GenericStageStatus;
export type WorkStageContract = GenericStageContract<WorkStageName>;
export type WorkStageLedger = GenericStageLedger<WorkStageName>;
export type WorkStageUpdate = GenericStageUpdate;

export function workStageLedgerPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "stages.json");
}

export function readWorkStageLedger(paths: DevtaskPaths, id: string): WorkStageLedger {
  return readGenericStageLedger(workStageLedgerPath(paths, id), id, WORK_STAGE_NAMES);
}

export function recordWorkStage(
  paths: DevtaskPaths,
  id: string,
  stage: WorkStageName,
  update: WorkStageUpdate
): WorkStageContract {
  return recordGenericStage(workStageLedgerPath(paths, id), workItemDir(paths, id), id, WORK_STAGE_NAMES, stage, update);
}

export async function runWorkStage<T>(
  paths: DevtaskPaths,
  id: string,
  stage: WorkStageName,
  start: Omit<WorkStageUpdate, "status">,
  run: () => Promise<{ result: T; final: WorkStageUpdate }>
): Promise<T> {
  return runGenericStage(workStageLedgerPath(paths, id), workItemDir(paths, id), id, WORK_STAGE_NAMES, stage, start, run);
}
