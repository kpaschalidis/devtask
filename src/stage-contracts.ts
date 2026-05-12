import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { taskDir } from "./paths.js";
import {
  readGenericStageLedger,
  recordGenericStage,
  runGenericStage,
  type GenericStageContract,
  type GenericStageLedger,
  type GenericStageStatus,
  type GenericStageUpdate
} from "./stage-ledger.js";

export const STAGE_NAMES = ["plan", "run", "check", "fix", "review", "approve", "commit", "pr", "ci"] as const;

export type StageName = (typeof STAGE_NAMES)[number];
export type StageStatus = GenericStageStatus;
export type StageContract = GenericStageContract<StageName>;
export type StageLedger = GenericStageLedger<StageName>;
export type StageUpdate = GenericStageUpdate;

export function readStageLedger(paths: DevtaskPaths, id: string): StageLedger {
  return readGenericStageLedger(stageLedgerPath(paths, id), id, STAGE_NAMES);
}

export function recordStage(paths: DevtaskPaths, id: string, stage: StageName, update: StageUpdate): StageContract {
  return recordGenericStage(stageLedgerPath(paths, id), taskDir(paths, id), id, STAGE_NAMES, stage, update);
}

export async function runStage<T>(
  paths: DevtaskPaths,
  id: string,
  stage: StageName,
  start: Omit<StageUpdate, "status">,
  run: () => Promise<{ result: T; final: StageUpdate }>
): Promise<T> {
  return runGenericStage(stageLedgerPath(paths, id), taskDir(paths, id), id, STAGE_NAMES, stage, start, run);
}

export function stageLedgerPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "stages.json");
}
