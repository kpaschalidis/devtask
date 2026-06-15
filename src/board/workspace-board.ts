import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { workItemPlanPath, workItemGraphPath, workItemRepoPlansDir, workItemResultsDir } from "../infra/paths.js";
import { readOrchestrateRecord } from "../services/work-service.js";
import { listWorkItems, type WorkItem } from "../storage/work-store.js";
import { listWorkPhaseSessions } from "../services/session-run-service.js";
import { recommendWorkNextAction } from "./next-actions.js";

export interface WorkspaceBoardRow {
  workId: string;
  title: string;
  source: string;
  status: string;
  repos: string;
  updatedAt: string;
  next: string;
}

export async function buildWorkspaceBoard(paths: DevtaskPaths): Promise<WorkspaceBoardRow[]> {
  const items = listWorkItems(paths);
  const rows: WorkspaceBoardRow[] = [];
  for (const item of items) {
    rows.push(await buildWorkspaceBoardRow(paths, item));
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function buildWorkspaceBoardRow(paths: DevtaskPaths, item: WorkItem): Promise<WorkspaceBoardRow> {
  const materialization = readWorkMaterialization(paths, item.id);
  const sessions = listWorkPhaseSessions(paths, item.id);
  const activeSession = sessions.find((session) => session.live) ?? null;
  const orchestrateRecord = readOrchestrateRecord(paths, item.id);
  const orchestratedPlan = hasOrchestratedPlan(paths, item.id);
  const ciWatch = readCiWatchSummary(paths, item.id);
  return {
    workId: item.id,
    title: item.source.title,
    source: item.source.type,
    status: summarizeStatus(item, orchestrateRecord?.status ?? null, materialization !== null, sessions.some((s) => s.live), ciWatch.status),
    repos: materialization ? materialization.tasks.map((task) => task.repoId).join(", ") : "-",
    updatedAt: newestUpdatedAt(item.updatedAt, [
      orchestrateRecord?.finishedAt ?? null,
      materialization?.materializedAt ?? null,
      ciWatch.updatedAt,
      ...sessions.map((session) => session.updatedAt)
    ]),
    next: activeSession
      ? phaseAttachCommand(item.id, activeSession.phase, activeSession.repoId)
      : recommendWorkNextAction(item, {
          hasOrchestratedPlan: orchestratedPlan,
          isMaterialized: materialization !== null,
          hasActiveSession: false
        })
  };
}

function summarizeStatus(
  item: WorkItem,
  orchestrateStatus: string | null,
  isMaterialized: boolean,
  hasActiveSession: boolean,
  ciWatchStatus: string | null
): string {
  if (hasActiveSession) return "executing";
  if (ciWatchStatus) return `ci-${ciWatchStatus}`;
  if (isMaterialized) return "materialized";
  if (orchestrateStatus === "planned") return "planned";
  if (orchestrateStatus === "failed") return "plan-failed";
  return item.status;
}

function readCiWatchSummary(paths: DevtaskPaths, workId: string): { status: string | null; updatedAt: string | null } {
  try {
    const filePath = path.join(workItemResultsDir(paths, workId), "ci-watch.json");
    if (!fs.existsSync(filePath)) {
      return { status: null, updatedAt: null };
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      status?: unknown;
      generatedAt?: unknown;
    };
    return {
      status: typeof value.status === "string" ? value.status : null,
      updatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null
    };
  } catch {
    return { status: null, updatedAt: null };
  }
}

function hasOrchestratedPlan(paths: DevtaskPaths, workId: string): boolean {
  if (!fs.existsSync(workItemPlanPath(paths, workId))) return false;
  if (!fs.existsSync(workItemGraphPath(paths, workId))) return false;
  const repoPlansDir = workItemRepoPlansDir(paths, workId);
  return fs.existsSync(repoPlansDir) && fs.readdirSync(repoPlansDir).some((entry) => entry.endsWith(".md"));
}

function newestUpdatedAt(fallback: string, values: Array<string | null>): string {
  return [fallback, ...values.filter((value): value is string => Boolean(value))].sort().at(-1) ?? fallback;
}

function phaseAttachCommand(workId: string, phase: string, repoId: string | null): string {
  return repoId
    ? `devtask work ${shellQuote(phase)} attach ${shellQuote(workId)} ${shellQuote(repoId)}`
    : `devtask work ${shellQuote(phase)} attach ${shellQuote(workId)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
