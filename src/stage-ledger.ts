import fs from "node:fs";
import { DevtaskError } from "./errors.js";

export type GenericStageStatus = "pending" | "running" | "passed" | "findings" | "failed" | "blocked" | "skipped";

export interface GenericStageContract<Stage extends string = string> {
  stage: Stage;
  status: GenericStageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifacts: string[];
  reason: string | null;
}

export interface GenericStageLedger<Stage extends string = string> {
  schemaVersion: 1;
  taskId: string;
  updatedAt: string;
  stages: Partial<Record<Stage, GenericStageContract<Stage>>>;
}

export interface GenericStageUpdate {
  status: GenericStageStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  artifacts?: string[];
  reason?: string | null;
}

export async function runGenericStage<T, Stage extends string>(
  filePath: string,
  ownerDir: string,
  id: string,
  stageNames: readonly Stage[],
  stage: Stage,
  start: Omit<GenericStageUpdate, "status">,
  run: () => Promise<{ result: T; final: GenericStageUpdate }>
): Promise<T> {
  recordGenericStage(filePath, ownerDir, id, stageNames, stage, {
    ...start,
    status: "running"
  });

  try {
    const { result, final } = await run();
    recordGenericStage(filePath, ownerDir, id, stageNames, stage, final);
    return result;
  } catch (error) {
    recordGenericStage(filePath, ownerDir, id, stageNames, stage, {
      status: "failed",
      input: start.input,
      artifacts: start.artifacts,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export function readGenericStageLedger<Stage extends string>(
  filePath: string,
  id: string,
  stageNames: readonly Stage[]
): GenericStageLedger<Stage> {
  if (!fs.existsSync(filePath)) {
    return emptyLedger(id);
  }

  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GenericStageLedger<Stage>>;
    return {
      schemaVersion: 1,
      taskId: typeof value.taskId === "string" ? value.taskId : id,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      stages: parseStages(value.stages, stageNames)
    };
  } catch (error) {
    const quarantinePath = `${filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(filePath, quarantinePath);
    throw new DevtaskError(
      `Stage ledger for task ${id} is corrupt and was moved to ${quarantinePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function recordGenericStage<Stage extends string>(
  filePath: string,
  ownerDir: string,
  id: string,
  stageNames: readonly Stage[],
  stage: Stage,
  update: GenericStageUpdate
): GenericStageContract<Stage> {
  const ledger = readGenericStageLedger(filePath, id, stageNames);
  const now = new Date().toISOString();
  const previous = ledger.stages[stage];
  const isNewAttempt = update.status === "running";
  const next: GenericStageContract<Stage> = {
    stage,
    status: update.status,
    startedAt: update.startedAt === undefined ? (isNewAttempt ? now : previous?.startedAt ?? null) : update.startedAt,
    finishedAt: update.finishedAt === undefined ? (update.status === "running" ? null : now) : update.finishedAt,
    input: update.input ?? (isNewAttempt ? {} : previous?.input ?? {}),
    output: update.output ?? (isNewAttempt ? {} : previous?.output ?? {}),
    artifacts: update.artifacts ?? (isNewAttempt ? [] : previous?.artifacts ?? []),
    reason: update.reason === undefined ? (isNewAttempt ? null : previous?.reason ?? null) : update.reason
  };

  const nextLedger: GenericStageLedger<Stage> = {
    schemaVersion: 1,
    taskId: id,
    updatedAt: now,
    stages: {
      ...ledger.stages,
      [stage]: next
    }
  };

  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(nextLedger, null, 2)}\n`);
  return next;
}

function emptyLedger<Stage extends string>(taskId: string): GenericStageLedger<Stage> {
  return {
    schemaVersion: 1,
    taskId,
    updatedAt: new Date(0).toISOString(),
    stages: {}
  };
}

function parseStages<Stage extends string>(
  value: unknown,
  stageNames: readonly Stage[]
): Partial<Record<Stage, GenericStageContract<Stage>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const stages: Partial<Record<Stage, GenericStageContract<Stage>>> = {};
  const record = value as Record<string, unknown>;
  for (const stage of stageNames) {
    stages[stage] = parseStage(stage, record[stage]);
  }

  return stages;
}

function parseStage<Stage extends string>(stage: Stage, value: unknown): GenericStageContract<Stage> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<GenericStageContract<Stage>>;
  if (record.stage !== stage || !isStageStatus(record.status)) {
    return undefined;
  }

  return {
    stage,
    status: record.status,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
    input: isObjectRecord(record.input) ? record.input : {},
    output: isObjectRecord(record.output) ? record.output : {},
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter((item): item is string => typeof item === "string") : [],
    reason: typeof record.reason === "string" ? record.reason : null
  };
}

function isStageStatus(value: unknown): value is GenericStageStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "passed" ||
    value === "findings" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
