import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { taskDir } from "./paths.js";

export const STAGE_NAMES = ["plan", "run", "check", "review", "approve", "commit", "pr", "ci"] as const;

export type StageName = (typeof STAGE_NAMES)[number];
export type StageStatus = "pending" | "running" | "passed" | "findings" | "failed" | "blocked" | "skipped";

export interface StageContract {
  stage: StageName;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifacts: string[];
  reason: string | null;
}

export interface StageLedger {
  schemaVersion: 1;
  taskId: string;
  updatedAt: string;
  stages: Partial<Record<StageName, StageContract>>;
}

export interface StageUpdate {
  status: StageStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  artifacts?: string[];
  reason?: string | null;
}

export function readStageLedger(paths: DevtaskPaths, id: string): StageLedger {
  const filePath = stageLedgerPath(paths, id);
  if (!fs.existsSync(filePath)) {
    return emptyLedger(id);
  }

  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StageLedger>;
    return {
      schemaVersion: 1,
      taskId: typeof value.taskId === "string" ? value.taskId : id,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      stages: parseStages(value.stages)
    };
  } catch {
    return emptyLedger(id);
  }
}

export function recordStage(paths: DevtaskPaths, id: string, stage: StageName, update: StageUpdate): StageContract {
  const ledger = readStageLedger(paths, id);
  const now = new Date().toISOString();
  const previous = ledger.stages[stage];
  const next: StageContract = {
    stage,
    status: update.status,
    startedAt: update.startedAt === undefined ? previous?.startedAt ?? (update.status === "running" ? now : null) : update.startedAt,
    finishedAt: update.finishedAt === undefined ? (update.status === "running" ? null : now) : update.finishedAt,
    input: update.input ?? previous?.input ?? {},
    output: update.output ?? previous?.output ?? {},
    artifacts: update.artifacts ?? previous?.artifacts ?? [],
    reason: update.reason === undefined ? previous?.reason ?? null : update.reason
  };

  const nextLedger: StageLedger = {
    schemaVersion: 1,
    taskId: id,
    updatedAt: now,
    stages: {
      ...ledger.stages,
      [stage]: next
    }
  };

  fs.mkdirSync(taskDir(paths, id), { recursive: true });
  fs.writeFileSync(stageLedgerPath(paths, id), `${JSON.stringify(nextLedger, null, 2)}\n`);
  return next;
}

export function stageLedgerPath(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "stages.json");
}

function emptyLedger(taskId: string): StageLedger {
  return {
    schemaVersion: 1,
    taskId,
    updatedAt: new Date(0).toISOString(),
    stages: {}
  };
}

function parseStages(value: unknown): Partial<Record<StageName, StageContract>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const stages: Partial<Record<StageName, StageContract>> = {};
  const record = value as Record<string, unknown>;
  for (const stage of STAGE_NAMES) {
    stages[stage] = parseStage(stage, record[stage]);
  }

  return stages;
}

function parseStage(stage: StageName, value: unknown): StageContract | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<StageContract>;
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

function isStageStatus(value: unknown): value is StageStatus {
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
