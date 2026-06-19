import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resolvePaths,
  taskMetaPath,
  taskStoragePaths,
  workItemCiWatchDir,
  workItemDir,
  workItemResultsDir,
  workItemReviewDir,
  workItemRepoPlanPath,
  workItemRepoContextPath,
  workItemRepoPlansDir,
  workItemLessonProposalsPath,
  phaseRunDir,
  resultJsonPath
} from "../infra/paths.js";
import { createDefaultAgentRunner, runAgentPrompt } from "../agent.js";
import { writePhaseRunRecord, readRunningPhaseRun, updateRunningPhaseRun, type SessionRun } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization, readWorkGraph, type WorkGraphTask } from "../work-materializer.js";
import {
  createJiraWorkItem,
  createManualWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type WorkItem,
  type WorkItemStatus
} from "../storage/work-store.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../adapters/jira.js";
import { updateRecentWork } from "../storage/global-index.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { runCommand, runCommandOrThrow } from "../infra/process-runner.js";
import { killTmuxSession, tmuxSessionExists } from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import { launchPhaseFresh } from "../roles/runner.js";
import type { RoleConfig } from "../roles/types.js";
import { orchestratorPhase } from "../roles/orchestrator.js";
import { reviewPhase } from "../roles/validator.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { loadInstruction } from "../instructions/loader.js";
import { getWorkspaceRepo } from "../storage/workspace-repos.js";
import type { WorkspaceRepo } from "../storage/workspace-repos.js";
import {
  executePhase,
  freshExecuteWork,
  runExecuteWork,
  summarizeExecuteWorkStatus,
  sendRawExecuteFeedback,
  type ExecuteTaskResult,
  type ExecuteWorkResult
} from "../roles/execute.js";
import {
  checkProviderCi,
  createProviderPullRequest,
  hasUncommittedChanges,
  preflightScmForPullRequest,
  pushBranchUpdate,
  type CiCheckResult
} from "../adapters/scm/index.js";

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
  status: CiCheckResult["status"] | "skipped" | "failed";
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
  lastCiStatus: CiCheckResult["status"] | null;
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

export interface PhaseLaunchResult {
  phase: string;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: "started" | "running";
  tmuxSession: string;
  promptPath: string;
  outputPath: string;
}

export type { ExecuteTaskResult, ExecuteWorkResult };

export interface CompoundWorkResult {
  workId: string;
  status: "completed" | "failed";
  promptPath: string;
  outputPath: string;
  sharedPlanningPath: string;
  sharedImplementationPath: string;
  sharedReviewPath: string;
  sharedPatternsPath: string;
  localNotesPath: string;
  generatedAt: string;
}

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

export function attachWorkPhase(paths: DevtaskPaths, phase: "orchestrate", workId: string): Promise<void>;
export function attachWorkPhase(paths: DevtaskPaths, phase: "review" | "execute", workId: string, repoId: string): Promise<void>;
export async function attachWorkPhase(
  paths: DevtaskPaths,
  phase: "orchestrate" | "review" | "execute",
  workId: string,
  repoId?: string
): Promise<void> {
  const scopeRepoId = repoId ?? null;
  switch (phase) {
    case "orchestrate": return orchestratorPhase.attach(paths, workId, null);
    case "review": return reviewPhase.attach(paths, workId, scopeRepoId);
    case "execute": return executePhase.attach(paths, workId, scopeRepoId);
  }
}

export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "orchestrate",
  workId: string,
  message: string
): Promise<PhaseLaunchResult>;
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "review",
  workId: string,
  repoId: string,
  message: string
): Promise<PhaseLaunchResult>;
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "execute",
  workId: string,
  repoId: string,
  message: string
): { confirmed: boolean; output: string };
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "orchestrate" | "review" | "execute",
  workId: string,
  repoOrMessage: string,
  maybeMessage?: string
): Promise<PhaseLaunchResult> | { confirmed: boolean; output: string } {
  const repoId = maybeMessage === undefined ? null : repoOrMessage;
  const message = maybeMessage === undefined ? repoOrMessage : maybeMessage;
  if (phase === "execute") {
    return sendRawExecuteFeedback(paths, workId, repoId!, message);
  }
  switch (phase) {
    case "orchestrate": return orchestratorPhase.sendFeedback(paths, workId, null, message);
    case "review": return reviewPhase.sendFeedback(paths, workId, repoId, message);
  }
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

type InteractivePhase = "orchestrate" | "review";

const PHASE_CONFIGS: Record<InteractivePhase, RoleConfig> = {
  orchestrate: orchestratorPhase,
  review: reviewPhase
};

export async function startOrchestrateWork(
  paths: DevtaskPaths,
  workId: string,
  opts?: { acceptRecommended?: boolean }
): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(orchestratorPhase, paths, workId, "orchestrate", null, opts);
}

export async function runRepoPlanWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const config = readConfig(paths);
  const graph = readWorkGraph(paths, workId);
  const graphTask = graph.tasks.find((t) => t.repoId === repoId);
  if (!graphTask) {
    throw new DevtaskError(`No task found in graph for repo ${repoId} in work item ${workId}`);
  }
  const repo = getWorkspaceRepo(paths, repoId);
  const runId = newRunId();
  const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
  fs.mkdirSync(phaseDir, { recursive: true });
  const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
  const outputPath = path.join(phaseDir, `${runId}.md`);
  const runtimePrefix = path.join(repo.repoPath, `.devtask_repo_plan_${runId}`);
  const runtimePlanPath = `${runtimePrefix}.md`;
  const runtimeStatePath = `${runtimePrefix}.state.md`;
  const resultPath = `${runtimePrefix}.result.json`;
  const finalPlanPath = workItemRepoPlanPath(paths, workId, repoId);
  const task = buildWorkerTaskDescription(workId, graphTask, repo);
  const state = `# State: ${graphTask.id}\n\n## Progress\n- Repo-plan phase for work ${workId}\n`;
  const memory = collectPhaseMemory(paths, "planning", { repoId });
  const contextPath = workItemRepoContextPath(paths, workId, repoId);
  const contextContent = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, "utf8").trim() : null;
  const prompt = loadInstruction("repo-plan", {
    TASK_ID: graphTask.id,
    TASK_CONTENT: task,
    STATE_CONTENT: state,
    PLAN_PATH: runtimePlanPath,
    CONTEXT: contextContent ? `## Orchestrator Context\n\n${contextContent}\n\n` : "",
    MEMORY: memory ? `${memory}\n\n` : ""
  });
  fs.writeFileSync(promptPath, `${prompt}\n`);
  const runner = createDefaultAgentRunner(config);
  const startOptions = {
    workspacePath: repo.repoPath,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: [workItemDir(paths, workId), repo.scope ? path.join(repo.repoPath, repo.scope) : repo.repoPath],
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: workItemDir(paths, workId),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_PLAN_PATH: runtimePlanPath,
      DEVTASK_STATE_PATH: runtimeStatePath,
      DEVTASK_RESULT_PATH: resultPath
    }
  } as const;
  const startedAt = new Date().toISOString();
  const result = await runAgentPrompt(runner, startOptions, prompt, { outputPath });
  const finishedAt = new Date().toISOString();
  persistSharedRepoPlan(runtimePlanPath, finalPlanPath);
  const blocked = readResultStatus(resultPath) === "blocked";
  removeIfExists(runtimePlanPath);
  removeIfExists(runtimeStatePath);
  removeIfExists(resultPath);
  const planExists = fs.existsSync(finalPlanPath) && fs.readFileSync(finalPlanPath, "utf8").trim().length > 0;
  const status = planExists ? (blocked ? "blocked" : "planned") : "failed";
  writePhaseRunRecord(phaseDir, {
    schemaVersion: 1,
    phase: "repo-plan",
    runId,
    workId,
    repoId,
    taskId: graphTask.id,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: { planPath: finalPlanPath },
    exitCode: status !== "failed" ? 0 : null
  });
  if (status === "failed") {
    throw new DevtaskError(`Repo-plan worker failed for ${repoId}`);
  }
}

export async function startReviewWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult[]> {
  const materialization = requireMaterialization(paths, workId);
  const launches: PhaseLaunchResult[] = [];
  for (const task of materialization.tasks) {
    launches.push(await startReviewScope(paths, workId, task.repoId));
  }
  return launches;
}

export async function startReviewScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(reviewPhase, paths, workId, "review", repoId);
}

export async function runValidateWorker(paths: DevtaskPaths, workId: string, featureId: string): Promise<void> {
  const graph = readWorkGraph(paths, workId);
  const feature = graph.features.find((f) => f.id === featureId);
  if (!feature) {
    throw new DevtaskError(`No feature "${featureId}" found in graph for work item ${workId}`);
  }
  if (!feature.validationRequired) {
    return;
  }
  const featureTasks = graph.tasks.filter((t) => feature.taskIds.includes(t.id));
  if (featureTasks.length === 0) {
    throw new DevtaskError(`Feature "${featureId}" has no tasks in graph for work item ${workId}`);
  }
  const repoIds = [...new Set(featureTasks.map((t) => t.repoId))];
  for (const repoId of repoIds) {
    await startReviewScope(paths, workId, repoId);
  }
}

export async function materializeWork(paths: DevtaskPaths, workId: string): Promise<WorkMaterialization> {
  const item = getWorkItem(paths, workId);
  const materialization = await materializeWorkPlan(paths, item);
  updateWorkItemStatus(paths, workId, "materialized");
  await updateRecentWork(paths, item);
  return materialization;
}


export async function compoundWork(paths: DevtaskPaths, workId: string): Promise<CompoundWorkResult> {
  const config = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const archiveDir = path.join(paths.sharedDir, "improvement", "archive", workId);
  const localArchiveDir = path.join(paths.localDir, "improvement", "archive", workId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(localArchiveDir, { recursive: true });
  const runsDir = phaseRunDir(paths, workId, "compound", null);
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = newRunId();
  const promptPath = path.join(runsDir, `${runId}.prompt.md`);
  const outputPath = path.join(runsDir, `${runId}.md`);
  const sharedPlanningPath = path.join(archiveDir, "planning.md");
  const sharedImplementationPath = path.join(archiveDir, "implementation.md");
  const sharedReviewPath = path.join(archiveDir, "review.md");
  const sharedPatternsPath = path.join(archiveDir, "patterns.md");
  const localNotesPath = path.join(localArchiveDir, "notes.md");
  const specFile = path.join(paths.workDir, workId, "spec.md");
  const specPath = fs.existsSync(specFile) ? specFile : null;
  const planPath = fs.existsSync(path.join(paths.workDir, workId, "plan.md")) ? path.join(paths.workDir, workId, "plan.md") : null;
  const graphPath = fs.existsSync(path.join(paths.workDir, workId, "graph.json")) ? path.join(paths.workDir, workId, "graph.json") : null;
  const proposalsPath = workItemLessonProposalsPath(paths, workId);
  fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
  const prompt = loadInstruction("compound", {
    WORK_ID: workId,
    SOURCE_PATH: item.source.artifact,
    SPEC_PATH: specPath ?? "-",
    PLAN_PATH: planPath ?? "-",
    GRAPH_PATH: graphPath ?? "-",
    REPO_PLANS_DIR: path.join(paths.workDir, workId, "repo-plans"),
    RESULTS_DIR: workItemResultsDir(paths, workId),
    REVIEWS_DIR: workItemReviewDir(paths, workId),
    SHARED_PLANNING_PATH: sharedPlanningPath,
    SHARED_IMPLEMENTATION_PATH: sharedImplementationPath,
    SHARED_REVIEW_PATH: sharedReviewPath,
    SHARED_PATTERNS_PATH: sharedPatternsPath,
    LOCAL_NOTES_PATH: localNotesPath,
    PROPOSALS_PATH: proposalsPath
  });
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const runner = createDefaultAgentRunner(config);
  const startOptions = {
    workspacePath: paths.root,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: [workItemDir(paths, workId), archiveDir, localArchiveDir],
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: workItemDir(paths, workId),
      DEVTASK_TASK_PATH: promptPath
    }
  } as const;
  const startedAt = new Date().toISOString();
  const result = await runAgentPrompt(runner, startOptions, prompt, { outputPath });
  const finishedAt = new Date().toISOString();
  const status: CompoundWorkResult["status"] = result.status === "completed" ? "completed" : "failed";
  writePhaseRunRecord(phaseRunDir(paths, workId, "compound", null), {
    schemaVersion: 1,
    phase: "compound",
    runId,
    workId,
    repoId: null,
    taskId: null,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      sharedPlanningPath,
      sharedImplementationPath,
      sharedReviewPath,
      sharedPatternsPath,
      localNotesPath,
      proposalsPath
    },
    exitCode: result.status === "completed" ? 0 : null
  });
  const compoundResult: CompoundWorkResult = {
    workId,
    status,
    promptPath,
    outputPath,
    sharedPlanningPath,
    sharedImplementationPath,
    sharedReviewPath,
    sharedPatternsPath,
    localNotesPath,
    generatedAt: finishedAt
  };
  writeWorkResult(paths, workId, "compound", compoundResult);
  if (compoundResult.status === "completed") {
    updateWorkItemStatus(paths, workId, "completed");
  }
  await updateRecentWork(paths, item);
  return compoundResult;
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

export async function runManagedPhaseHookFinalizer(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  runId: string,
  repoId: string | null
): Promise<void> {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (!current || current.runId !== runId || current.status !== "running") {
    return;
  }
  const { status } = await finalizeInteractivePhase(paths, phase, workId, repoId, current);
  if (status !== "failed" && current.tmuxSession && tmuxSessionExists(current.tmuxSession)) {
    killTmuxSession(current.tmuxSession);
  }
}

async function runDeterministicChecks(
  paths: DevtaskPaths,
  workId: string,
  repoIds?: readonly string[]
): Promise<VerifyWorkResult> {
  const materialization = requireMaterialization(paths, workId);
  const targetTasks = repoIds?.length
    ? materialization.tasks.filter((task) => repoIds.includes(task.repoId))
    : materialization.tasks;
  const tasks: VerifyTaskResult[] = [];

  for (const task of targetTasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const config = readConfig(repoPaths);
    if (config.verify.length === 0) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        status: "skipped",
        commands: [],
        error: null
      });
      continue;
    }

    const commandResults: VerifyCommandResult[] = [];
    let taskStatus: VerifyTaskResult["status"] = "passed";
    let taskError: string | null = null;

    for (const command of config.verify) {
      const result = await runCommand("sh", ["-c", command], { cwd: task.worktreePath });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
      const status: VerifyCommandResult["status"] = result.exitCode === 0 ? "passed" : "failed";
      commandResults.push({
        command,
        status,
        exitCode: result.exitCode,
        output
      });
      if (status === "failed") {
        taskStatus = "failed";
        taskError = output || `Command failed with exit code ${result.exitCode ?? "unknown"}`;
        break;
      }
    }

    tasks.push({
      repoId: task.repoId,
      taskId: task.taskId,
      worktreePath: task.worktreePath,
      status: taskStatus,
      commands: commandResults,
      error: taskError
    });
  }

  const result: VerifyWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  return result;
}

async function runDeterministicChecksForRepo(paths: DevtaskPaths, workId: string, repoId: string): Promise<VerifyTaskResult> {
  const result = await runDeterministicChecks(paths, workId, [repoId]);
  const task = result.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No deterministic check result found for repo ${repoId} in work item ${workId}`);
  }
  return task;
}

async function hydratePhaseSession(
  paths: DevtaskPaths,
  session: AgentSessionRef,
  workspacePath: string,
  tmuxSession: string
): Promise<AgentSessionRef> {
  const runner = createDefaultAgentRunner(readConfig(paths));
  const hydrated = runner.hydrateSessionRef ? await runner.hydrateSessionRef(session, workspacePath) : session;
  return {
    ...hydrated,
    transportId: tmuxSession
  };
}


function phaseWorkItemStatus(phase: InteractivePhase, status: string): WorkItemStatus | null {
  switch (phase) {
    case "orchestrate": return status === "planned" ? "planned" : "failed";
    case "review": return null;
  }
}

async function finalizeInteractivePhase(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  repoId: string | null,
  sessionRecord: SessionRun
): Promise<{ status: string }> {
  const cfg = PHASE_CONFIGS[phase];
  const workspacePath = cfg.workspacePath(paths, workId, repoId);
  const session = await hydratePhaseSession(paths, sessionRecord.session, workspacePath, sessionRecord.tmuxSession ?? "");
  const finishedAt = new Date().toISOString();
  const { status, artifacts } = await cfg.finalize(paths, workId, repoId, sessionRecord);
  const itemStatus = phaseWorkItemStatus(phase, status);
  if (itemStatus !== null) {
    updateWorkItemStatus(paths, workId, itemStatus);
    await updateRecentWork(paths, getWorkItem(paths, workId));
  }
  writePhaseRunRecord(phaseRunDir(paths, workId, phase, repoId), {
    schemaVersion: 1,
    phase,
    runId: sessionRecord.runId,
    workId,
    repoId: repoId ?? null,
    taskId: sessionRecord.taskId,
    status,
    promptPath: sessionRecord.promptPath,
    outputPath: sessionRecord.outputPath,
    startedAt: sessionRecord.startedAt,
    finishedAt,
    session,
    artifacts,
    exitCode: status === "failed" ? null : 0
  });
  updateRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    status: status === "blocked" ? "blocked" : status === "failed" ? "failed" : "completed",
    updatedAt: finishedAt,
    promptPath: sessionRecord.promptPath,
    outputPath: sessionRecord.outputPath,
    artifacts,
    session,
    taskId: sessionRecord.taskId,
    runId: sessionRecord.runId
  });
  return { status };
}


export async function createWorkPullRequests(
  paths: DevtaskPaths,
  workId: string,
  options: { draft?: boolean } = {}
): Promise<PullRequestWorkResult> {
  const item = getWorkItem(paths, workId);
  const workspaceConfig = readConfig(paths);
  const materialization = requireMaterialization(paths, workId);
  const multiRepo = materialization.tasks.length > 1;
  const tasks: PullRequestTaskResult[] = [];

  for (const task of materialization.tasks) {
    const storagePaths = taskStoragePaths(paths, task.repoPath);
    const metaPath = taskMetaPath(storagePaths, task.taskId);
    const meta = readTaskMeta(metaPath);
    const preflight = await preflightScmForPullRequest(task.worktreePath, { draft: options.draft === true }, workspaceConfig);

    if (meta.prUrl) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "skipped",
        prUrl: meta.prUrl,
        detail: "pull request already exists"
      });
      continue;
    }

    if (preflight.access !== "ok") {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "failed",
        prUrl: null,
        detail: preflight.accessDetail ?? "SCM access check failed"
      });
      continue;
    }

    if (!preflight.clean) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "failed",
        prUrl: null,
        detail: "worktree has uncommitted changes"
      });
      continue;
    }

    if (preflight.commits < 1) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "skipped",
        prUrl: null,
        detail: "no commits to publish"
      });
      continue;
    }

    try {
      const prUrl = await createProviderPullRequest(
        task.worktreePath,
        {
          title: buildPullRequestTitle(item, task.repoId, multiRepo),
          body: buildPullRequestBody(item, task.repoId),
          draft: options.draft === true,
          branch: task.branch
        },
        workspaceConfig
      );
      writeTaskMeta(metaPath, {
        ...meta,
        prUrl,
        updatedAt: new Date().toISOString()
      });
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "created",
        prUrl,
        detail: "pull request created"
      });
    } catch (error) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "failed",
        prUrl: null,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const result: PullRequestWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "pr", result);
  if (tasks.some((task) => task.status === "created" || task.prUrl !== null)) {
    updateWorkItemStatus(paths, workId, "pr-open");
  }
  return result;
}

export async function checkWorkCi(paths: DevtaskPaths, workId: string): Promise<CiWorkResult> {
  const workspaceConfig = readConfig(paths);
  const materialization = requireMaterialization(paths, workId);
  const tasks: CiTaskResult[] = [];

  for (const task of materialization.tasks) {
    const storagePaths = taskStoragePaths(paths, task.repoPath);
    const metaPath = taskMetaPath(storagePaths, task.taskId);
    const meta = readTaskMeta(metaPath);

    if (!meta.prUrl) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "skipped",
        detail: "no pull request url recorded",
        url: null
      });
      continue;
    }

    try {
      const result = await checkProviderCi(task.worktreePath, meta.prUrl, task.branch, workspaceConfig);
      writeTaskMeta(metaPath, {
        ...meta,
        updatedAt: new Date().toISOString()
      });
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: result.status,
        detail: result.detail,
        url: result.url
      });
    } catch (error) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        url: meta.prUrl
      });
    }
  }

  const result: CiWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "ci", result);
  if (tasks.length > 0 && tasks.every((task) => task.status === "passed" || task.status === "skipped")) {
    updateWorkItemStatus(paths, workId, "completed");
  }
  return result;
}

export async function watchWorkCi(
  paths: DevtaskPaths,
  workId: string,
  options: { pollIntervalMs?: number; maxPolls?: number } = {}
): Promise<CiWatchWorkResult> {
  const workspaceConfig = readConfig(paths);
  const materialization = requireMaterialization(paths, workId);
  const tasks: CiWatchTaskResult[] = [];
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const maxPolls = options.maxPolls ?? 120;

  for (const task of materialization.tasks) {
    const storagePaths = taskStoragePaths(paths, task.repoPath);
    const metaPath = taskMetaPath(storagePaths, task.taskId);
    const meta = readTaskMeta(metaPath);

    if (!meta.prUrl) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        prUrl: null,
        status: "skipped",
        detail: "no pull request url recorded",
        url: null,
        attempts: 0,
        lastCiStatus: null,
        latestFailureLogPath: null,
        fixRuns: []
      });
      continue;
    }

    let attempts = 0;
    let polls = 0;
    let latestFailureLogPath: string | null = null;
    const fixRuns: CiFixAttemptResult[] = [];
    let finalTask: CiWatchTaskResult | null = null;

    try {
      while (!finalTask) {
        const ci = await checkProviderCi(task.worktreePath, meta.prUrl, task.branch, workspaceConfig);

        if (ci.status === "passed") {
          finalTask = {
            repoId: task.repoId,
            taskId: task.taskId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            prUrl: meta.prUrl,
            status: "passed",
            detail: ci.detail,
            url: ci.url,
            attempts,
            lastCiStatus: ci.status,
            latestFailureLogPath,
            fixRuns
          };
          break;
        }

        if (ci.status === "running") {
          polls += 1;
          if (polls >= maxPolls) {
            finalTask = {
              repoId: task.repoId,
              taskId: task.taskId,
              branch: task.branch,
              worktreePath: task.worktreePath,
              prUrl: meta.prUrl,
              status: "running",
              detail: ci.detail,
              url: ci.url,
              attempts,
              lastCiStatus: ci.status,
              latestFailureLogPath,
              fixRuns
            };
            break;
          }
          await sleep(pollIntervalMs);
          continue;
        }

        if (ci.status !== "failed") {
          finalTask = {
            repoId: task.repoId,
            taskId: task.taskId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            prUrl: meta.prUrl,
            status: "unknown",
            detail: ci.detail,
            url: ci.url,
            attempts,
            lastCiStatus: ci.status,
            latestFailureLogPath,
            fixRuns
          };
          break;
        }

        latestFailureLogPath = writeCiFailureLog(paths, workId, task.repoId, attempts + 1, ci.failureOutput ?? ci.detail);

        if (attempts >= workspaceConfig.ci.maxFixAttempts) {
          finalTask = {
            repoId: task.repoId,
            taskId: task.taskId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            prUrl: meta.prUrl,
            status: "max-attempts",
            detail: `maximum CI fix attempts reached (${workspaceConfig.ci.maxFixAttempts})`,
            url: ci.url,
            attempts,
            lastCiStatus: ci.status,
            latestFailureLogPath,
            fixRuns
          };
          break;
        }

        attempts += 1;
        const fixRun = await runCiFixAttempt(paths, workId, {
          repoId: task.repoId,
          taskId: task.taskId,
          branch: task.branch,
          worktreePath: task.worktreePath,
          prUrl: meta.prUrl,
          attempt: attempts,
          failureDetail: ci.detail,
          failureLogPath: latestFailureLogPath
        });
        fixRuns.push(fixRun);

        if (fixRun.status === "blocked" || fixRun.status === "failed") {
          finalTask = {
            repoId: task.repoId,
            taskId: task.taskId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            prUrl: meta.prUrl,
            status: "fix-failed",
            detail: fixRun.detail,
            url: ci.url,
            attempts,
            lastCiStatus: ci.status,
            latestFailureLogPath,
            fixRuns
          };
          break;
        }

        if (fixRun.status === "validation-failed") {
          finalTask = {
            repoId: task.repoId,
            taskId: task.taskId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            prUrl: meta.prUrl,
            status: "validation-failed",
            detail: fixRun.detail,
            url: ci.url,
            attempts,
            lastCiStatus: ci.status,
            latestFailureLogPath,
            fixRuns
          };
          break;
        }

        polls = 0;
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      finalTask = {
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        worktreePath: task.worktreePath,
        prUrl: meta.prUrl,
        status: "unknown",
        detail: error instanceof Error ? error.message : String(error),
        url: meta.prUrl,
        attempts,
        lastCiStatus: null,
        latestFailureLogPath,
        fixRuns
      };
    }

    tasks.push(finalTask ?? {
      repoId: task.repoId,
      taskId: task.taskId,
      branch: task.branch,
      worktreePath: task.worktreePath,
      prUrl: meta.prUrl,
      status: "unknown",
      detail: "CI watch exited without a terminal task result",
      url: meta.prUrl,
      attempts,
      lastCiStatus: null,
      latestFailureLogPath,
      fixRuns
    });
  }

  const result: CiWatchWorkResult = {
    workId,
    status: deriveCiWatchStatus(tasks),
    tasks,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "ci-watch", result);
  if (result.status === "completed") {
    updateWorkItemStatus(paths, workId, "completed");
    await updateRecentWork(paths, getWorkItem(paths, workId));
  } else if (result.status === "blocked") {
    updateWorkItemStatus(paths, workId, "blocked");
    await updateRecentWork(paths, getWorkItem(paths, workId));
  }
  return result;
}

async function runCiFixAttempt(
  paths: DevtaskPaths,
  workId: string,
  options: {
    repoId: string;
    taskId: string;
    branch: string;
    worktreePath: string;
    prUrl: string;
    attempt: number;
    failureDetail: string;
    failureLogPath: string | null;
  }
): Promise<CiFixAttemptResult> {
  const config = readConfig(paths);
  const runId = newRunId();
  const phaseDir = phaseRunDir(paths, workId, "ci-fix", options.repoId);
  const attemptDir = path.join(workItemCiWatchDir(paths, workId), options.repoId, `attempt-${options.attempt}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(attemptDir, { recursive: true });
  const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
  const outputPath = path.join(phaseDir, `${runId}.md`);
  const statePath = path.join(attemptDir, "state.md");
  const resultPath = path.join(attemptDir, "result.json");
  const startedAt = new Date().toISOString();
  const headBefore = await gitHead(options.worktreePath);
  const prompt = buildCiFixPrompt(paths, workId, options);

  fs.writeFileSync(promptPath, `${prompt}\n`);
  fs.writeFileSync(statePath, `# State: ${options.taskId} ci-fix\n\n## Progress\n- Attempt ${options.attempt} started ${startedAt}\n`);
  fs.writeFileSync(resultPath, "{\n  \"status\": \"pending\"\n}\n");

  const runner = createDefaultAgentRunner(config);
  const result = await runAgentPrompt(
    runner,
    {
      workspacePath: options.worktreePath,
      model: config.codex.model,
      fullAuto: config.codex.fullAuto,
      skipGitRepoCheck: true,
      addDirs: [workItemDir(paths, workId), options.worktreePath],
      env: {
        ...process.env,
        DEVTASK_TASK_DIR: attemptDir,
        DEVTASK_TASK_PATH: promptPath,
        DEVTASK_STATE_PATH: statePath,
        DEVTASK_RESULT_PATH: resultPath
      }
    },
    prompt,
    { outputPath }
  );

  const finishedAt = new Date().toISOString();
  const resultStatus = readResultStatus(resultPath);
  const sessionStatus =
    result.status === "completed"
      ? resultStatus === "blocked" ? "blocked" : "completed"
      : "failed";
  writePhaseRunRecord(phaseDir, {
    schemaVersion: 1,
    phase: "ci-fix",
    runId,
    workId,
    repoId: options.repoId,
    taskId: options.taskId,
    status: sessionStatus,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      statePath,
      resultPath,
      ...(options.failureLogPath ? { failureLogPath: options.failureLogPath } : {})
    },
    exitCode: result.status === "completed" ? 0 : null
  });

  if (result.status !== "completed") {
    return {
      attempt: options.attempt,
      status: "failed",
      promptPath,
      outputPath,
      statePath,
      resultPath,
      failureLogPath: options.failureLogPath,
      validation: null,
      detail: result.error ?? "CI fix agent did not complete successfully"
    };
  }

  if (resultStatus === "blocked") {
    return {
      attempt: options.attempt,
      status: "blocked",
      promptPath,
      outputPath,
      statePath,
      resultPath,
      failureLogPath: options.failureLogPath,
      validation: null,
      detail: readBlockedReason(resultPath) ?? "CI fix agent reported blocked"
    };
  }

  if (await hasUncommittedChanges(options.worktreePath)) {
    return {
      attempt: options.attempt,
      status: "failed",
      promptPath,
      outputPath,
      statePath,
      resultPath,
      failureLogPath: options.failureLogPath,
      validation: null,
      detail: "CI fix attempt left uncommitted changes in the worktree"
    };
  }

  const headAfter = await gitHead(options.worktreePath);
  if (headAfter === headBefore) {
    return {
      attempt: options.attempt,
      status: "failed",
      promptPath,
      outputPath,
      statePath,
      resultPath,
      failureLogPath: options.failureLogPath,
      validation: null,
      detail: "CI fix attempt completed without creating a new commit"
    };
  }

  const validation = await runDeterministicChecksForRepo(paths, workId, options.repoId);
  writeScopedVerifyResult(paths, workId, "check", validation);
  if (validation.status !== "passed" && validation.status !== "skipped") {
    return {
      attempt: options.attempt,
      status: "validation-failed",
      promptPath,
      outputPath,
      statePath,
      resultPath,
      failureLogPath: options.failureLogPath,
      validation,
      detail: validation.error ?? "deterministic validation failed after CI fix"
    };
  }

  await pushBranchUpdate(options.worktreePath, options.branch);
  return {
    attempt: options.attempt,
    status: "completed",
    promptPath,
    outputPath,
    statePath,
    resultPath,
    failureLogPath: options.failureLogPath,
    validation,
    detail: "CI fix applied, validated, and pushed to the PR branch"
  };
}

function requireMaterialization(paths: DevtaskPaths, workId: string): WorkMaterialization {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new Error(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  }
  return materialization;
}

function writeWorkResult(paths: DevtaskPaths, workId: string, name: string, value: unknown): void {
  const dir = workItemResultsDir(paths, workId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

function writeScopedVerifyResult(paths: DevtaskPaths, workId: string, name: string, task: VerifyTaskResult): void {
  const existing = readVerifyWorkResult(paths, workId, name);
  const tasks = existing.tasks.filter((entry) => entry.repoId !== task.repoId);
  tasks.push(task);
  tasks.sort((left, right) => left.repoId.localeCompare(right.repoId));
  writeWorkResult(paths, workId, name, {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  });
}

function readVerifyWorkResult(paths: DevtaskPaths, workId: string, name: string): VerifyWorkResult {
  try {
    const filePath = path.join(workItemResultsDir(paths, workId), `${name}.json`);
    if (!fs.existsSync(filePath)) {
      return { workId, tasks: [], generatedAt: new Date(0).toISOString() };
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<VerifyWorkResult>;
    return {
      workId,
      tasks: Array.isArray(value.tasks) ? value.tasks as VerifyTaskResult[] : [],
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : new Date(0).toISOString()
    };
  } catch {
    return { workId, tasks: [], generatedAt: new Date(0).toISOString() };
  }
}

function writeCiFailureLog(paths: DevtaskPaths, workId: string, repoId: string, attempt: number, output: string): string {
  const dir = path.join(workItemCiWatchDir(paths, workId), repoId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `attempt-${attempt}.failure.log`);
  fs.writeFileSync(filePath, `${truncateCiFailureOutput(output)}\n`);
  return filePath;
}

function truncateCiFailureOutput(output: string): string {
  const normalized = output.trim();
  if (normalized.length <= 16_000) {
    return normalized;
  }
  return `${normalized.slice(0, 16_000)}\n[truncated by devtask]`;
}

function deriveCiWatchStatus(tasks: CiWatchTaskResult[]): CiWatchWorkResult["status"] {
  if (tasks.every((task) => task.status === "passed" || task.status === "skipped")) {
    return "completed";
  }
  if (tasks.some((task) => task.status === "running")) {
    return "running";
  }
  return "blocked";
}

function buildCiFixPrompt(
  paths: DevtaskPaths,
  workId: string,
  options: {
    repoId: string;
    taskId: string;
    branch: string;
    worktreePath: string;
    prUrl: string;
    attempt: number;
    failureDetail: string;
    failureLogPath: string | null;
  }
): string {
  return [
    `# Task ${options.taskId}`,
    "",
    "## Goal",
    `Fix the CI failure for work item ${workId} on repo ${options.repoId}, then commit the scoped fix on branch ${options.branch}.`,
    "",
    "## Context",
    `- work item: ${workId}`,
    `- repo id: ${options.repoId}`,
    `- branch: ${options.branch}`,
    `- worktree: ${options.worktreePath}`,
    `- pull request: ${options.prUrl}`,
    `- CI fix attempt: ${options.attempt}`,
    `- work source artifact: ${path.join(workItemDir(paths, workId), "source.md")}`,
    `- work plan artifact: ${path.join(workItemDir(paths, workId), "plan.md")}`,
    "",
    "## CI Failure",
    options.failureDetail,
    ...(options.failureLogPath ? ["", `Full failure output: ${options.failureLogPath}`] : []),
    "",
    "## Requirements",
    "- Work inside the existing task worktree only.",
    "- Fix the root cause of the CI failure.",
    "- Run only the smallest commands you need while investigating.",
    "- Commit the scoped fix before finishing.",
    "- Do not open a new pull request.",
    "- If blocked, write {\"status\":\"blocked\",\"reason\":\"...\"} to $DEVTASK_RESULT_PATH.",
    "- If complete, write {\"status\":\"done\"} to $DEVTASK_RESULT_PATH."
  ].join("\n");
}

async function gitHead(worktreePath: string): Promise<string> {
  const result = await runCommandOrThrow("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  return result.stdout.trim();
}

function readBlockedReason(resultPath: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { reason?: unknown };
    return typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : null;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPullRequestTitle(item: WorkItem, repoId: string, multiRepo: boolean): string {
  return multiRepo ? `${item.id}: ${item.source.title} (${repoId})` : `${item.id}: ${item.source.title}`;
}

function buildPullRequestBody(item: WorkItem, repoId: string): string {
  return [
    `Work: ${item.id}`,
    `Repo: ${repoId}`,
    `Source: ${item.source.artifact}`,
    "",
    "Created by devtask."
  ].join("\n");
}

function buildWorkerTaskDescription(workId: string, graphTask: WorkGraphTask, repo: WorkspaceRepo): string {
  return [
    `# Task ${graphTask.id}`,
    "",
    "## Goal",
    graphTask.goal,
    "",
    "## Work Item",
    `- id: ${workId}`,
    `- repo id: ${repo.id}`,
    `- repo path: ${repo.repoPath}`,
    `- repo scope: ${repo.scope ?? "."}`,
    "",
    "## Ownership",
    ...(graphTask.owns.length > 0 ? graphTask.owns.map((e) => `- ${e}`) : ["- none"]),
    "",
    "## Dependencies",
    ...(graphTask.dependencies.length > 0
      ? graphTask.dependencies.map((d) => `- ${d.task} (${d.type})${d.reason != null ? `: ${d.reason}` : ""}`)
      : ["- none"])
  ].join("\n");
}

function persistSharedRepoPlan(runtimePlanPath: string, finalPlanPath: string): void {
  try {
    const plan = fs.readFileSync(runtimePlanPath, "utf8").trim();
    if (!plan) return;
    fs.mkdirSync(path.dirname(finalPlanPath), { recursive: true });
    fs.writeFileSync(finalPlanPath, `${plan}\n`);
  } catch {
    // no runtime plan to persist
  }
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function resetTaskForFix(paths: DevtaskPaths, workId: string, repoId: string): void {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work item "${workId}" has not been materialized.`);
  }
  const task = materialization.tasks.find((t) => t.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No materialized task found for repo "${repoId}" in work item "${workId}".`);
  }
  removeIfExists(resultJsonPath(paths, task.taskId));
}
