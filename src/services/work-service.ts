import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resolvePaths,
  taskMetaPath,
  taskStoragePaths,
  workItemDir,
  workItemResultsDir,
  workItemReviewDir,
  phaseRunDir,
  workItemSpecPath
} from "../infra/paths.js";
import { createDefaultAgentRunner, runAgentPrompt } from "../agent.js";
import { writePhaseRunRecord, readRunningPhaseRun, updateRunningPhaseRun, type PhaseRun } from "../infra/phase-run.js";
import { newRunId } from "../infra/run-record.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import { readWorkGraph } from "../work-materializer.js";
import type { PlanRecord } from "../repo-plan.js";
import { readLatestWorkPlanRecord, type WorkPlanRecord } from "../global-plan.js";
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
import { runCommand } from "../infra/process-runner.js";
import { killTmuxSession, tmuxSessionExists } from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import { launchPhaseFresh } from "../phases/runner.js";
import type { PhaseConfig } from "../phases/types.js";
import { specPhase } from "../phases/spec.js";
import { planPhase } from "../phases/plan.js";
import { repoPlanPhase } from "../phases/repo-plan.js";
import { reviewPhase } from "../phases/review.js";
import {
  executePhase,
  freshExecuteWork,
  runExecuteWork,
  summarizeExecuteWorkStatus,
  sendRawExecuteFeedback,
  type ExecuteTaskResult,
  type ExecuteWorkResult
} from "../phases/execute.js";
import { buildCompoundPrompt } from "../prompts/compound.js";
import {
  checkProviderCi,
  createProviderPullRequest,
  preflightScmForPullRequest,
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

export interface RepoPlanTaskResult {
  repoId: string;
  taskId: string;
  status: PlanRecord["status"];
  planPath: string;
  outputPath: string;
  worktreeChanged: boolean;
}

export interface WorkSpecResult {
  runId: string;
  workId: string;
  status: "spec-ready" | "failed";
  specPath: string;
  promptPath: string;
  outputPath: string;
  exitCode: number | null;
  generatedAt: string;
  session: AgentSessionRef;
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

export interface RepoPlanWorkResult {
  workId: string;
  repoPlans: RepoPlanTaskResult[];
  materialized: boolean;
  generatedAt: string;
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

export function attachWorkPhase(paths: DevtaskPaths, phase: "spec" | "plan", workId: string): Promise<void>;
export function attachWorkPhase(paths: DevtaskPaths, phase: "repo-plan" | "review" | "execute", workId: string, repoId: string): Promise<void>;
export async function attachWorkPhase(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review" | "execute",
  workId: string,
  repoId?: string
): Promise<void> {
  const scopeRepoId = repoId ?? null;
  switch (phase) {
    case "spec": return specPhase.attach(paths, workId, null);
    case "plan": return planPhase.attach(paths, workId, null);
    case "repo-plan": return repoPlanPhase.attach(paths, workId, scopeRepoId);
    case "review": return reviewPhase.attach(paths, workId, scopeRepoId);
    case "execute": return executePhase.attach(paths, workId, scopeRepoId);
  }
}

export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "spec" | "plan",
  workId: string,
  message: string
): Promise<PhaseLaunchResult>;
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "repo-plan" | "review",
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
  phase: "spec" | "plan" | "repo-plan" | "review" | "execute",
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
    case "spec": return specPhase.sendFeedback(paths, workId, null, message);
    case "plan": return planPhase.sendFeedback(paths, workId, null, message);
    case "repo-plan": return repoPlanPhase.sendFeedback(paths, workId, repoId, message);
    case "review": return reviewPhase.sendFeedback(paths, workId, repoId, message);
  }
}

export { freshExecuteWork };

export async function executeWork(paths: DevtaskPaths, workId: string): Promise<ExecuteWorkResult> {
  const item = getWorkItem(paths, workId);
  const result = await runExecuteWork(paths, workId);
  updateWorkItemStatus(paths, workId, summarizeExecuteWorkStatus(result.tasks));
  await updateRecentWork(paths, item);
  return result;
}

type InteractivePhase = "spec" | "plan" | "repo-plan" | "review";

const PHASE_CONFIGS: Record<InteractivePhase, PhaseConfig> = {
  spec: specPhase,
  plan: planPhase,
  "repo-plan": repoPlanPhase,
  review: reviewPhase
};

export async function startSpecWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(specPhase, paths, workId, "spec", null);
}

export async function startPlanWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(planPhase, paths, workId, "plan", null);
}

export async function startRepoPlanWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult[]> {
  const item = getWorkItem(paths, workId);
  const planRecord = readLatestWorkPlanRecord(paths, workId);
  if (!planRecord || planRecord.status !== "planned") {
    throw new DevtaskError(`Global work plan is not ready for ${workId}. Run devtask work plan ${workId} first.`);
  }
  const graph = readWorkGraph(paths, workId);
  const launches: PhaseLaunchResult[] = [];
  for (const graphTask of graph.tasks) {
    launches.push(await startRepoPlanScope(paths, workId, graphTask.repoId));
  }
  await updateRecentWork(paths, item);
  return launches;
}

export async function startReviewWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult[]> {
  const materialization = requireMaterialization(paths, workId);
  const launches: PhaseLaunchResult[] = [];
  for (const task of materialization.tasks) {
    launches.push(await startReviewScope(paths, workId, task.repoId));
  }
  return launches;
}

export async function startRepoPlanScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(repoPlanPhase, paths, workId, "repo-plan", repoId);
}

export async function startReviewScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(reviewPhase, paths, workId, "review", repoId);
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
  const specPath = fs.existsSync(workItemSpecPath(paths, workId)) ? workItemSpecPath(paths, workId) : null;
  const planPath = fs.existsSync(path.join(paths.workDir, workId, "plan.md")) ? path.join(paths.workDir, workId, "plan.md") : null;
  const graphPath = fs.existsSync(path.join(paths.workDir, workId, "graph.json")) ? path.join(paths.workDir, workId, "graph.json") : null;
  const prompt = buildCompoundPrompt({
    workId,
    sourcePath: item.source.artifact,
    specPath,
    planPath,
    graphPath,
    repoPlansDir: path.join(paths.workDir, workId, "repo-plans"),
    resultsDir: workItemResultsDir(paths, workId),
    reviewsDir: workItemReviewDir(paths, workId),
    sharedPlanningPath,
    sharedImplementationPath,
    sharedReviewPath,
    sharedPatternsPath,
    localNotesPath
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
      localNotesPath
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

export function readWorkPlanRecord(paths: DevtaskPaths, workId: string): WorkPlanRecord | null {
  return readLatestWorkPlanRecord(paths, workId);
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
  await finalizeInteractivePhase(paths, phase, workId, repoId, current);
  if (current.tmuxSession && tmuxSessionExists(current.tmuxSession)) {
    killTmuxSession(current.tmuxSession);
  }
}

async function runDeterministicChecks(paths: DevtaskPaths, workId: string): Promise<VerifyWorkResult> {
  const materialization = requireMaterialization(paths, workId);
  const tasks: VerifyTaskResult[] = [];

  for (const task of materialization.tasks) {
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
    case "spec": return status === "spec-ready" ? "spec-ready" : "failed";
    case "plan": return status === "planned" ? "planned" : "failed";
    case "repo-plan": return status === "failed" ? "failed" : "planned";
    case "review": return null;
  }
}

async function finalizeInteractivePhase(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  repoId: string | null,
  sessionRecord: PhaseRun
): Promise<void> {
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

