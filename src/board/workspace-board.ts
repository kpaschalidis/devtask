import fs from "node:fs";
import type { DevtaskPaths } from "../infra/paths.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { readWorkPlanRecord } from "../services/work-service.js";
import { listWorkItems, type WorkItem } from "../storage/work-store.js";
import { listSessions } from "../services/session-service.js";
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
  const sessions = await listSessions(paths, item.id);
  const planRecord = readWorkPlanRecord(paths, item.id);
  return {
    workId: item.id,
    title: item.source.title,
    source: item.source.type,
    status: summarizeStatus(item, planRecord?.status ?? null, materialization !== null, sessions.some((session) => session.status === "active")),
    repos: materialization ? materialization.tasks.map((task) => task.repoId).join(", ") : "-",
    updatedAt: newestUpdatedAt(item.updatedAt, [
      planRecord?.finishedAt ?? null,
      materialization?.materializedAt ?? null,
      ...sessions.map((session) => session.updatedAt)
    ]),
    next: recommendWorkNextAction(item, {
      hasPlan: planRecord?.status === "planned" || hasPlanArtifacts(paths, item.id),
      isMaterialized: materialization !== null,
      hasActiveSession: sessions.some((session) => session.status === "active")
    })
  };
}

function summarizeStatus(item: WorkItem, planStatus: string | null, isMaterialized: boolean, hasActiveSession: boolean): string {
  if (hasActiveSession) {
    return "implementing";
  }
  if (isMaterialized) {
    return "ready";
  }
  if (planStatus === "planned") {
    return "planned";
  }
  if (planStatus === "failed") {
    return "plan-failed";
  }
  return item.status;
}

function hasPlanArtifacts(paths: DevtaskPaths, workId: string): boolean {
  return fs.existsSync(paths.workDir) && fs.existsSync(`${paths.workDir}/${workId}/plan.md`);
}

function newestUpdatedAt(fallback: string, values: Array<string | null>): string {
  return [fallback, ...values.filter((value): value is string => Boolean(value))].sort().at(-1) ?? fallback;
}
