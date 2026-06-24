import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  workItemResultsDir,
  phaseRunDir,
  resultJsonPath
} from "../infra/paths.js";
import { writePhaseRunRecord, readRunningPhaseRun, updateRunningPhaseRun, type SessionRun } from "../infra/session-run.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import {
  createJiraWorkItem,
  createManualWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type WorkItem
} from "../storage/work-store.js";
import { readConfig } from "../infra/config.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../adapters/jira.js";
import { updateRecentWork } from "../storage/global-index.js";
import { DevtaskError } from "../infra/errors.js";
import {
  freshExecuteWork,
  runExecuteWork,
  summarizeExecuteWorkStatus,
  type ExecuteTaskResult,
  type ExecuteWorkResult
} from "../roles/execute.js";
export { runRepoPlanWorker } from "./repo-plan-work-service.js";
export { compoundWork } from "./compound-work-service.js";
export { createWorkPullRequests } from "./pull-request-work-service.js";
export { checkWorkCi, watchWorkCi, resetTaskForFix } from "./ci-work-service.js";
export {
  attachWorkPhase,
  runManagedPhaseHookFinalizer,
  runValidateWorker,
  sendWorkPhaseFeedback,
  startOrchestrateWork,
  startReviewScope,
  startReviewWork,
} from "./phase-work-service.js";
export type { PhaseLaunchResult } from "./phase-work-service.js";
export type { CompoundWorkResult } from "./compound-work-service.js";
import { writeWorkResult } from "./work-result-service.js";
import { runDeterministicChecks } from "./deterministic-check-service.js";

export interface VerifyCommandResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
}

export interface VerifyTaskResult {
  repoId: string;
  taskId: string;
  worktreePath: string;
  status: "passed" | "failed" | "skipped";
  commands: VerifyCommandResult[];
  error: string | null;
}

export interface VerifyWorkResult {
  workId: string;
  tasks: VerifyTaskResult[];
  generatedAt: string;
}

export interface PullRequestTaskResult {
  repoId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  status: "created" | "skipped" | "failed";
  prUrl: string | null;
  detail: string;
}

export interface PullRequestWorkResult {
  workId: string;
  tasks: PullRequestTaskResult[];
  generatedAt: string;
}

export interface CiTaskResult {
  repoId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  status: "passed" | "failed" | "running" | "unknown" | "skipped";
  detail: string;
  url: string | null;
}

export interface CiWorkResult {
  workId: string;
  tasks: CiTaskResult[];
  generatedAt: string;
}

export interface CiFixAttemptResult {
  attempt: number;
  status: "completed" | "blocked" | "failed" | "validation-failed";
  promptPath: string;
  outputPath: string;
  statePath: string;
  resultPath: string;
  failureLogPath: string | null;
  validation: VerifyTaskResult | null;
  detail: string;
}

export interface CiWatchTaskResult {
  repoId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  prUrl: string | null;
  status: "passed" | "skipped" | "running" | "max-attempts" | "fix-failed" | "validation-failed" | "unknown";
  detail: string;
  url: string | null;
  attempts: number;
  lastCiStatus: "passed" | "failed" | "running" | "unknown" | null;
  latestFailureLogPath: string | null;
  fixRuns: CiFixAttemptResult[];
}

export interface CiWatchWorkResult {
  workId: string;
  status: "completed" | "blocked" | "running";
  tasks: CiWatchTaskResult[];
  generatedAt: string;
}


export interface ReviewTaskResult {
  repoId: string;
  taskId: string;
  status: "approved" | "findings" | "blocked" | "failed";
  branch: string;
  worktreePath: string;
  reviewPath: string;
  resultPath: string;
  prUrl: string | null;
  summary: string;
  findings: string[];
  latestCheck: string | null;
  latestVerify: string | null;
  latestCi: string | null;
}

export interface ReviewWorkResult {
  workId: string;
  tasks: ReviewTaskResult[];
  generatedAt: string;
}

export type { ExecuteTaskResult, ExecuteWorkResult };

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

export { approveWorkGate } from "../mission/approve.js";
export { freshExecuteWork };
export { watchWorkPullRequests } from "./pr-watch-service.js";

export async function executeWork(paths: DevtaskPaths, workId: string): Promise<ExecuteWorkResult> {
  const item = getWorkItem(paths, workId);
  const result = await runExecuteWork(paths, workId);
  updateWorkItemStatus(paths, workId, summarizeExecuteWorkStatus(result.tasks));
  await updateRecentWork(paths, item);
  return result;
}

export async function materializeWork(paths: DevtaskPaths, workId: string): Promise<WorkMaterialization> {
  const item = getWorkItem(paths, workId);
  const materialization = await materializeWorkPlan(paths, item);
  updateWorkItemStatus(paths, workId, "materialized");
  await updateRecentWork(paths, item);
  return materialization;
}


export function getWorkMaterializationState(paths: DevtaskPaths, workId: string): WorkMaterialization | null {
  return readWorkMaterialization(paths, workId);
}

export interface OrchestrateRecord {
  runId: string;
  workId: string;
  status: "planned" | "failed";
  finishedAt: string;
}

export function readOrchestrateRecord(paths: DevtaskPaths, workId: string): OrchestrateRecord | null {
  const runsDir = phaseRunDir(paths, workId, "orchestrate", null);
  if (!fs.existsSync(runsDir)) return null;
  const latest = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith(".json") && f !== "running.json")
    .sort()
    .at(-1);
  if (!latest) return null;
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, latest), "utf8")) as {
    runId: string;
    workId: string;
    status: string;
    finishedAt: string;
  };
  return {
    runId: run.runId,
    workId: run.workId,
    status: run.status === "planned" ? "planned" : "failed",
    finishedAt: run.finishedAt
  };
}

export async function cleanupWork(paths: DevtaskPaths, workId: string, options: WorkCleanupOptions = {}): Promise<WorkCleanupResult> {
  return cleanupWorkItem(paths, getWorkItem(paths, workId), options);
}

export async function verifyWork(paths: DevtaskPaths, workId: string): Promise<VerifyWorkResult> {
  const result = await runDeterministicChecks(paths, workId);
  writeWorkResult(paths, workId, "verify", result);
  return result;
}

export async function checkWork(paths: DevtaskPaths, workId: string): Promise<VerifyWorkResult> {
  const result = await runDeterministicChecks(paths, workId);
  writeWorkResult(paths, workId, "check", result);
  return result;
}

function requireMaterialization(paths: DevtaskPaths, workId: string): WorkMaterialization {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new Error(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  }
  return materialization;
}

function readResultStatus(resultPath: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown };
    return typeof value.status === "string" ? value.status : "pending";
  } catch {
    return "pending";
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
