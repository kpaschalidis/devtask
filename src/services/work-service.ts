import type { DevtaskConfig } from "../config.js";
import { readConfig } from "../config.js";
import type { DevtaskPaths } from "../paths.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { approveWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import {
  readLatestWorkPlanRecord,
  runWorkPlanner,
  type WorkPlanRecord,
  type WorkPlanStart
} from "../work-planner.js";
import {
  createJiraWorkItem,
  createManualWorkItem,
  getWorkItem,
  listWorkItems,
  type WorkItem
} from "../work-store.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../jira.js";
import { updateRecentWork } from "../global-index.js";

export function createManualWork(
  paths: DevtaskPaths,
  options: { id: string; title: string; body?: string | null }
): WorkItem {
  const item = createManualWorkItem(paths, options);
  void updateRecentWork(paths, item);
  return item;
}

export async function importJiraWork(paths: DevtaskPaths, workId: string, issueKey: string): Promise<WorkItem> {
  const config = readConfig(paths);
  const issue = await fetchJiraIssue(config, issueKey);
  const artifacts = writeJiraSourceArtifacts(paths, issue);
  const item = createJiraWorkItem(paths, {
    id: workId,
    key: issue.key,
    title: issue.summary,
    url: issue.url,
    artifact: artifacts.markdownPath
  });
  await updateRecentWork(paths, item);
  return item;
}

export function listWork(paths: DevtaskPaths): WorkItem[] {
  return listWorkItems(paths);
}

export function getWork(paths: DevtaskPaths, workId: string): WorkItem {
  return getWorkItem(paths, workId);
}

export async function planWork(
  paths: DevtaskPaths,
  workId: string,
  options: {
    onStart?: (start: WorkPlanStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {}
): Promise<WorkPlanRecord> {
  const config: DevtaskConfig = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const record = await runWorkPlanner(paths, item, config, options);
  await updateRecentWork(paths, item);
  return record;
}

export async function materializeWork(paths: DevtaskPaths, workId: string): Promise<WorkMaterialization> {
  const item = getWorkItem(paths, workId);
  const materialization = await approveWorkPlan(paths, item);
  await updateRecentWork(paths, item);
  return materialization;
}

export function getWorkMaterializationState(paths: DevtaskPaths, workId: string): WorkMaterialization | null {
  return readWorkMaterialization(paths, workId);
}

export function readWorkPlanRecord(paths: DevtaskPaths, workId: string): WorkPlanRecord | null {
  return readLatestWorkPlanRecord(paths, workId);
}

export async function cleanupWork(paths: DevtaskPaths, workId: string, options: WorkCleanupOptions = {}): Promise<WorkCleanupResult> {
  return cleanupWorkItem(paths, getWorkItem(paths, workId), options);
}
