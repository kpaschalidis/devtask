import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import type { DevtaskConfig } from "../infra/config.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resolvePaths,
  taskMetaPath,
  taskStoragePaths,
  workItemDir,
  workItemGraphSnapshotPath,
  workItemPlanRunsDir,
  workItemPhaseSessionsDir,
  workItemRepoPlanPath,
  workItemResultsDir,
  workItemReviewDir,
  workItemPhaseRunsDir,
  workItemRepoPhaseRunsDir,
  workItemSessionRegistryDir,
  workItemSpecPath,
  workItemSpecRunsDir
} from "../infra/paths.js";
import { createDefaultAgentRunner, resumeAgentPrompt, runAgentPrompt } from "../agent.js";
import { writeAgentSessionRegistryEntry } from "../infra/agent-session-registry.js";
import { writePhaseRunRecord } from "../infra/phase-run.js";
import { newRunId } from "../infra/run-record.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import { readWorkGraph } from "../work-materializer.js";
import { readLatestPlan, runPlanAgent, type PlanAgentStart, type PlanRecord } from "../repo-plan.js";
import {
  readLatestWorkPlanRecord,
  runWorkPlanner,
  type WorkPlanRecord,
  type WorkPlanStart
} from "../global-plan.js";
import {
  createJiraWorkItem,
  createManualWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type WorkItem
} from "../storage/work-store.js";
import { getWorkspaceRepo } from "../storage/workspace-repos.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../adapters/jira.js";
import { updateRecentWork } from "../storage/global-index.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { runCommand } from "../infra/process-runner.js";
import {
  createBareSession,
  killTmuxSession,
  sendLaunchCommand,
  startTmuxSession,
  tmuxSessionExists,
  tmuxSessionName,
  waitForTmuxSession,
  writeLaunchScript
} from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import { getLatestWorkPhaseRun } from "./phase-run-service.js";
import { buildReviewPrompt } from "../prompts/review.js";
import { buildSpecPrompt } from "../prompts/spec-plan.js";
import { buildCompoundPrompt } from "../prompts/compound.js";
import { buildRepoPlanPrompt } from "../prompts/repo-plan.js";
import {
  attachScopedPhaseSession,
  ensureNoLiveScopedPhaseSession,
  freshExecuteSession,
  phaseWorkerCommand,
  readScopedPhaseSession,
  sendScopedPhaseFeedback,
  updateScopedPhaseSession,
  writeRunningScopedPhaseSession,
  markExecutePhaseSession,
  listWorkPhaseSessions
} from "./phase-session-service.js";
import {
  checkProviderCi,
  countBranchCommits,
  createProviderPullRequest,
  hasUncommittedChanges,
  preflightScmForPullRequest,
  type CiCheckResult
} from "../adapters/scm/index.js";
import type { TaskMeta } from "../types.js";

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
  phase: "spec" | "plan" | "repo-plan" | "review" | "execute";
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

export interface ExecuteTaskResult {
  repoId: string;
  taskId: string;
  status: "running" | "paused" | "blocked" | "done" | "failed";
  action: "started" | "reattached" | "resumed" | "skipped";
  sessionName: string | null;
  summary: string | null;
  worktreePath: string;
}

export interface ExecuteWorkResult {
  workId: string;
  tasks: ExecuteTaskResult[];
  generatedAt: string;
}

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

export function attachWorkPhase(paths: DevtaskPaths, phase: "spec" | "plan", workId: string): void;
export function attachWorkPhase(paths: DevtaskPaths, phase: "repo-plan" | "review" | "execute", workId: string, repoId: string): void;
export function attachWorkPhase(paths: DevtaskPaths, phase: "spec" | "plan" | "repo-plan" | "review" | "execute", workId: string, repoId?: string): void {
  attachScopedPhaseSession(paths, workId, phase, repoId ?? null);
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
    return sendScopedPhaseFeedback(paths, workId, phase, message, repoId);
  }
  return startPhaseFeedbackSession(paths, phase, workId, message, repoId);
}

export function freshExecuteWork(paths: DevtaskPaths, workId: string, repoId: string): void {
  freshExecuteSession(paths, workId, repoId);
}

function launchPhaseWorker(cwd: string, tmuxSession: string, args: string[], workspaceRoot?: string): void {
  if (tmuxSessionExists(tmuxSession)) {
    killTmuxSession(tmuxSession);
  }
  const scriptLines = [
    `cd ${shellEscape(cwd)}`,
    workspaceRoot ? `export DEVTASK_WORKSPACE_ROOT=${shellEscape(workspaceRoot)}` : null,
    `exec ${phaseWorkerCommand(args)}`
  ].filter((line): line is string => Boolean(line));
  const scriptPath = writeLaunchScript(scriptLines.join("\n"));
  startTmuxSession(tmuxSession, ["bash", scriptPath], cwd);
  if (!waitForTmuxSession(tmuxSession, { attempts: 5, intervalMs: 200 })) {
    throw new DevtaskError(`Phase session ${tmuxSession} failed to start`);
  }
}

async function startPhaseFeedbackSession(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review",
  workId: string,
  feedback: string,
  repoId: string | null
): Promise<PhaseLaunchResult> {
  ensureNoLiveScopedPhaseSession(paths, workId, phase, repoId);
  const previous = readResumeSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const { tmuxSession, cwd, promptPath, outputPath, taskId, artifacts } = preparePhaseFeedbackScope(paths, phase, workId, repoId, runId);
  const prompt = buildPhaseFeedbackPrompt(phase, feedback, previous.session);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, `${prompt}\n`);
  const args = repoId
    ? ["work", feedbackWorkerCommand(phase), workId, repoId]
    : ["work", feedbackWorkerCommand(phase), workId];
  launchPhaseWorker(cwd, tmuxSession, args, paths.root);
  writeRunningScopedPhaseSession(paths, {
    phase,
    workId,
    repoId,
    taskId,
    runId,
    tmuxSession,
    startedAt,
    promptPath,
    outputPath,
    artifacts,
    session: {
      ...previous.session,
      transportId: tmuxSession,
      summary: `${phase} feedback session started`,
      summaryIsFallback: true
    }
  });
  return { phase, workId, repoId, taskId, status: "started", tmuxSession, promptPath, outputPath };
}

function feedbackWorkerCommand(phase: "spec" | "plan" | "repo-plan" | "review"): string {
  switch (phase) {
    case "spec":
      return "_spec-feedback-worker";
    case "plan":
      return "_plan-feedback-worker";
    case "repo-plan":
      return "_repo-plan-feedback-worker";
    case "review":
      return "_review-feedback-worker";
  }
}

function buildPhaseFeedbackPrompt(
  phase: "spec" | "plan" | "repo-plan" | "review",
  feedback: string,
  session: AgentSessionRef
): string {
  return [
    `Continue the ${phase} task using the existing ${session.provider} session context.`,
    "",
    "Update the existing artifact based on this feedback:",
    "",
    feedback.trim()
  ].join("\n");
}

function readResumeSession(
  paths: DevtaskPaths,
  workId: string,
  phase: "spec" | "plan" | "repo-plan" | "review",
  repoId: string | null
): { session: AgentSessionRef; taskId: string | null } {
  const current = readScopedPhaseSession(paths, workId, phase, repoId);
  if (current?.session.resumeTarget || current?.session.providerSessionId || current?.session.conversationId) {
    return {
      session: current.session,
      taskId: current.taskId
    };
  }

  const latest = getLatestWorkPhaseRun(paths, workId, phase, repoId ?? undefined);
  if (latest?.session.resumeTarget || latest?.session.providerSessionId || latest?.session.conversationId) {
    return {
      session: latest.session,
      taskId: latest.taskId
    };
  }

  throw new DevtaskError(`No resumable ${phase} session exists for ${repoId ? `${workId}/${repoId}` : workId}`);
}

function preparePhaseFeedbackScope(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review",
  workId: string,
  repoId: string | null,
  runId: string
): {
  tmuxSession: string;
  cwd: string;
  promptPath: string;
  outputPath: string;
  taskId: string | null;
  artifacts: Record<string, string>;
} {
  if (phase === "spec") {
    return {
      tmuxSession: tmuxSessionName(paths, `spec-${workId}`),
      cwd: paths.root,
      promptPath: path.join(workItemSpecRunsDir(paths, workId), `${runId}.prompt.md`),
      outputPath: path.join(workItemSpecRunsDir(paths, workId), `${runId}.md`),
      taskId: null,
      artifacts: {
        specPath: workItemSpecPath(paths, workId)
      }
    };
  }
  if (phase === "plan") {
    return {
      tmuxSession: tmuxSessionName(paths, `plan-${workId}`),
      cwd: paths.root,
      promptPath: path.join(workItemPlanRunsDir(paths, workId), `${runId}.prompt.md`),
      outputPath: path.join(workItemPlanRunsDir(paths, workId), `${runId}.md`),
      taskId: null,
      artifacts: {
        planPath: path.join(workItemDir(paths, workId), "plan.md"),
        graphPath: path.join(workItemDir(paths, workId), "graph.json")
      }
    };
  }
  if (phase === "repo-plan") {
    if (!repoId) {
      throw new DevtaskError("repo-plan feedback requires a repo id");
    }
    const graph = readWorkGraph(paths, workId);
    const graphTask = graph.tasks.find((entry) => entry.repoId === repoId);
    if (!graphTask) {
      throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
    }
    const repo = getWorkspaceRepo(paths, repoId);
    const phaseDir = workItemRepoPhaseRunsDir(paths, workId, "repo-plan", repoId);
    return {
      tmuxSession: tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`),
      cwd: repo.repoPath,
      promptPath: path.join(phaseDir, `${runId}.prompt.md`),
      outputPath: path.join(phaseDir, `${runId}.md`),
      taskId: graphTask.id,
      artifacts: {
        planPath: workItemRepoPlanPath(paths, workId, repoId)
      }
    };
  }
  if (!repoId) {
    throw new DevtaskError("review feedback requires a repo id");
  }
  const materialization = requireMaterialization(paths, workId);
  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
  }
  const reviewDir = workItemReviewDir(paths, workId);
  return {
    tmuxSession: tmuxSessionName(resolvePaths(task.repoPath), `review-${workId}-${repoId}`),
    cwd: task.worktreePath,
    promptPath: `${reviewDir}/${repoId}.prompt.md`,
    outputPath: `${reviewDir}/${repoId}.output.md`,
    taskId: task.taskId,
    artifacts: {
      reviewPath: `${reviewDir}/${repoId}.md`,
      resultPath: `${reviewDir}/${repoId}.json`
    }
  };
}

export async function startSpecWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  const item = getWorkItem(paths, workId);
  ensureNoLiveScopedPhaseSession(paths, workId, "spec");
  const runId = Date.now().toString();
  const runsDir = workItemSpecRunsDir(paths, item.id);
  fs.mkdirSync(runsDir, { recursive: true });
  const promptPath = `${runsDir}/${runId}.prompt.md`;
  const outputPath = `${runsDir}/${runId}.md`;
  fs.writeFileSync(promptPath, `${buildSpecPrompt(item, workItemSpecPath(paths, item.id))}\n`);
  const tmuxSession = tmuxSessionName(paths, `spec-${workId}`);
  launchPhaseWorker(paths.root, tmuxSession, ["work", "_spec-worker", workId], paths.root);
  writeRunningScopedPhaseSession(paths, {
    phase: "spec",
    workId,
    repoId: null,
    taskId: null,
    runId,
    tmuxSession,
    startedAt: new Date().toISOString(),
    promptPath,
    outputPath,
    artifacts: {
      specPath: workItemSpecPath(paths, item.id)
    },
    session: {
      provider: readConfig(paths).agent.provider,
      transportId: tmuxSession,
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: null,
      transcriptPath: null,
      summary: "spec session started",
      summaryIsFallback: true
    }
  });
  return { phase: "spec", workId, repoId: null, taskId: null, status: "started", tmuxSession, promptPath, outputPath };
}

export async function startPlanWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  requireWorkSpec(paths, workId);
  ensureNoLiveScopedPhaseSession(paths, workId, "plan");
  const runId = newRunId();
  const runsDir = workItemPlanRunsDir(paths, workId);
  fs.mkdirSync(runsDir, { recursive: true });
  const promptPath = path.join(runsDir, `${runId}.prompt.md`);
  const outputPath = path.join(runsDir, `${runId}.md`);
  const tmuxSession = tmuxSessionName(paths, `plan-${workId}`);
  launchPhaseWorker(paths.root, tmuxSession, ["work", "_plan-worker", workId], paths.root);
  writeRunningScopedPhaseSession(paths, {
    phase: "plan",
    workId,
    repoId: null,
    taskId: null,
    runId,
    tmuxSession,
    startedAt: new Date().toISOString(),
    promptPath,
    outputPath,
    artifacts: {
      planPath: path.join(workItemDir(paths, workId), "plan.md"),
      graphPath: path.join(workItemDir(paths, workId), "graph.json")
    },
    session: {
      provider: readConfig(paths).agent.provider,
      transportId: tmuxSession,
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: null,
      transcriptPath: null,
      summary: "plan session started",
      summaryIsFallback: true
    }
  });
  return { phase: "plan", workId, repoId: null, taskId: null, status: "started", tmuxSession, promptPath, outputPath };
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
  const graph = readWorkGraph(paths, workId);
  const graphTask = graph.tasks.find((entry) => entry.repoId === repoId);
  if (!graphTask) {
    throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
  }
  ensureNoLiveScopedPhaseSession(paths, workId, "repo-plan", repoId);
  const tmuxSession = tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`);
  const runId = newRunId();
  const phaseDir = workItemRepoPhaseRunsDir(paths, workId, "repo-plan", repoId);
  fs.mkdirSync(phaseDir, { recursive: true });
  const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
  const outputPath = path.join(phaseDir, `${runId}.md`);
  const repo = getWorkspaceRepo(paths, repoId);
  launchPhaseWorker(repo.repoPath, tmuxSession, ["work", "_repo-plan-worker", workId, repoId], paths.root);
  writeRunningScopedPhaseSession(paths, {
    phase: "repo-plan",
    workId,
    repoId,
    taskId: graphTask.id,
    runId,
    tmuxSession,
    startedAt: new Date().toISOString(),
    promptPath,
    outputPath,
    artifacts: {
      planPath: workItemRepoPlanPath(paths, workId, repoId)
    },
    session: {
      provider: readConfig(paths).agent.provider,
      transportId: tmuxSession,
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: null,
      transcriptPath: null,
      summary: "repo-plan session started",
      summaryIsFallback: true
    }
  });
  return { phase: "repo-plan", workId, repoId, taskId: graphTask.id, status: "started", tmuxSession, promptPath, outputPath };
}

export async function startReviewScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  const materialization = requireMaterialization(paths, workId);
  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
  }
  ensureNoLiveScopedPhaseSession(paths, workId, "review", repoId);
  const tmuxSession = tmuxSessionName(resolvePaths(task.repoPath), `review-${workId}-${repoId}`);
  const reviewDir = workItemReviewDir(paths, workId);
  fs.mkdirSync(reviewDir, { recursive: true });
  const promptPath = `${reviewDir}/${repoId}.prompt.md`;
  const outputPath = `${reviewDir}/${repoId}.output.md`;
  launchPhaseWorker(task.worktreePath, tmuxSession, ["work", "_review-worker", workId, repoId], paths.root);
  writeRunningScopedPhaseSession(paths, {
    phase: "review",
    workId,
    repoId,
    taskId: task.taskId,
    runId: newRunId(),
    tmuxSession,
    startedAt: new Date().toISOString(),
    promptPath,
    outputPath,
    artifacts: {
      reviewPath: `${reviewDir}/${repoId}.md`,
      resultPath: `${reviewDir}/${repoId}.json`
    },
    session: {
      provider: readConfig(paths).agent.provider,
      transportId: tmuxSession,
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: null,
      transcriptPath: null,
      summary: "review session started",
      summaryIsFallback: true
    }
  });
  return { phase: "review", workId, repoId, taskId: task.taskId, status: "started", tmuxSession, promptPath, outputPath };
}

export async function planWork(
  paths: DevtaskPaths,
  workId: string,
  options: {
    onStart?: (start: WorkPlanStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  } = {}
): Promise<WorkPlanRecord> {
  const config: DevtaskConfig = readConfig(paths);
  const item = getWorkItem(paths, workId);
  requireWorkSpec(paths, workId);
  const record = await runWorkPlanner(paths, item, config, options);
  updateWorkItemStatus(paths, workId, record.status === "planned" ? "planned" : "failed");
  await updateRecentWork(paths, item);
  return record;
}

export async function specWork(
  paths: DevtaskPaths,
  workId: string,
  options: {
    onStart?: (start: { command: string; promptPath: string; outputPath: string; specPath: string }) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  } = {}
): Promise<WorkSpecResult> {
  const config: DevtaskConfig = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const result = await runSpecAgent(paths, item, config, options);
  writeWorkResult(paths, workId, "spec", result);
  updateWorkItemStatus(paths, workId, result.status === "spec-ready" ? "spec-ready" : "failed");
  await updateRecentWork(paths, item);
  return result;
}

export async function repoPlanWork(
  paths: DevtaskPaths,
  workId: string,
  options: {
    refresh?: boolean;
    onRepoPlanStart?: (repoId: string, start: PlanAgentStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {}
): Promise<RepoPlanWorkResult> {
  const item = getWorkItem(paths, workId);
  const planRecord = readLatestWorkPlanRecord(paths, workId);
  if (!planRecord || planRecord.status !== "planned") {
    throw new Error(`Global work plan is not ready for ${workId}. Run devtask work plan ${workId} first.`);
  }

  const repoPlans: RepoPlanTaskResult[] = [];
  const graph = readWorkGraph(paths, workId);

  if (paths.workspaceId === null) {
    const existingMaterialization = readWorkMaterialization(paths, workId);
    const materialization = existingMaterialization ?? (await materializeWorkPlan(paths, item));

    for (const task of materialization.tasks) {
      const storagePaths = taskStoragePaths(paths, task.repoPath);
      const meta = readTaskMeta(taskMetaPath(storagePaths, task.taskId));
      const latestPlan = readLatestPlan(storagePaths, task.taskId);

      if (latestPlan && !options.refresh) {
        repoPlans.push({
          repoId: task.repoId,
          taskId: task.taskId,
          status: latestPlan.status,
          planPath: latestPlan.planPath,
          outputPath: latestPlan.outputPath,
          worktreeChanged: latestPlan.worktreeChanged
        });
        continue;
      }

      const record = await runPlanAgent(storagePaths, meta, {
        workspacePaths: paths,
        workId,
        repoId: task.repoId
      }, {
        model: meta.model,
        fullAuto: true,
        onStart: (start) => options.onRepoPlanStart?.(task.repoId, start),
        onStdout: options.onStdout,
        onStderr: options.onStderr
      });
      persistSharedRepoPlan(paths, workId, task.repoId, record.planPath);
      repoPlans.push({
        repoId: task.repoId,
        taskId: task.taskId,
        status: record.status,
        planPath: record.planPath,
        outputPath: record.outputPath,
        worktreeChanged: record.worktreeChanged
      });
    }

    const repoPlanResult = {
      workId,
      repoPlans,
      materialized: existingMaterialization !== null,
      generatedAt: new Date().toISOString()
    };
    writeWorkResult(paths, workId, "repo-plan", repoPlanResult);
    updateWorkItemStatus(paths, workId, repoPlans.every((task) => task.status !== "failed") ? "planned" : "failed");
    await updateRecentWork(paths, item);
    return repoPlanResult;
  }

  for (const graphTask of graph.tasks) {
    const repo = getWorkspaceRepo(paths, graphTask.repoId);
    const repoPlanPath = workItemRepoPlanPath(paths, workId, graphTask.repoId);
    const phaseRunsDir = workItemRepoPhaseRunsDir(paths, workId, "repo-plan", graphTask.repoId);
    const latestRun = readLatestPhaseRunStatus(phaseRunsDir);

    if (latestRun && fs.existsSync(repoPlanPath) && !options.refresh) {
      repoPlans.push({
        repoId: graphTask.repoId,
        taskId: graphTask.id,
        status: latestRun.status as RepoPlanTaskResult["status"],
        planPath: repoPlanPath,
        outputPath: latestRun.outputPath,
        worktreeChanged: false
      });
      continue;
    }

    const record = await runWorkspaceRepoPlan(paths, item, graphTask, repo, {
      onStart: (start) => options.onRepoPlanStart?.(graphTask.repoId, start),
      onStdout: options.onStdout,
      onStderr: options.onStderr
    });
    repoPlans.push({
      repoId: graphTask.repoId,
      taskId: graphTask.id,
      status: record.status,
      planPath: record.planPath,
      outputPath: record.outputPath,
      worktreeChanged: false
    });
  }

  const repoPlanResult = {
    workId,
    repoPlans,
    materialized: false,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "repo-plan", repoPlanResult);
  updateWorkItemStatus(paths, workId, repoPlans.every((task) => task.status !== "failed") ? "planned" : "failed");
  await updateRecentWork(paths, item);
  return repoPlanResult;
}

export async function materializeWork(paths: DevtaskPaths, workId: string): Promise<WorkMaterialization> {
  const item = getWorkItem(paths, workId);
  const materialization = await materializeWorkPlan(paths, item);
  updateWorkItemStatus(paths, workId, "materialized");
  await updateRecentWork(paths, item);
  return materialization;
}

export async function executeWork(paths: DevtaskPaths, workId: string): Promise<ExecuteWorkResult> {
  const item = getWorkItem(paths, workId);
  const materialization = requireMaterialization(paths, workId);
  const tasks: ExecuteTaskResult[] = [];

  for (const task of materialization.tasks) {
    tasks.push(await executeMaterializedTask(paths, workId, task));
  }

  const result: ExecuteWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "execute", result);
  updateWorkItemStatus(paths, workId, summarizeExecuteWorkStatus(result.tasks));
  await updateRecentWork(paths, item);
  return result;
}

export async function compoundWork(paths: DevtaskPaths, workId: string): Promise<CompoundWorkResult> {
  const config = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const archiveDir = path.join(paths.sharedDir, "improvement", "archive", workId);
  const localArchiveDir = path.join(paths.localDir, "improvement", "archive", workId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(localArchiveDir, { recursive: true });
  const runsDir = workItemPhaseRunsDir(paths, workId, "compound");
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
  writePhaseRunRecord(workItemPhaseRunsDir(paths, workId, "compound"), {
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
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(paths, workId), {
    schemaVersion: 1,
    runId,
    workId,
    phase: "compound",
    repoId: null,
    taskId: null,
    status,
    startedAt,
    finishedAt,
    session: result.session
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

export async function reviewWork(paths: DevtaskPaths, workId: string): Promise<ReviewWorkResult> {
  const materialization = requireMaterialization(paths, workId);
  const latestCheck = readWorkResultSummary(paths, workId, "check");
  const latestVerify = readWorkResultSummary(paths, workId, "verify");
  const latestCi = readWorkResultSummary(paths, workId, "ci");
  const tasks: ReviewTaskResult[] = [];
  const config = readConfig(paths);

  for (const task of materialization.tasks) {
    tasks.push(await runReviewAgent(paths, workId, task, config, { latestCheck, latestVerify, latestCi }));
  }

  const result: ReviewWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  writeWorkResult(paths, workId, "review", result);
  updateWorkItemStatus(paths, workId, summarizeReviewWorkStatus(result.tasks));
  return result;
}

export async function runSpecWorker(paths: DevtaskPaths, workId: string): Promise<WorkSpecResult> {
  const result = await specWork(paths, workId);
  updateScopedPhaseSession(paths, workId, "spec", null, {
    status: result.status === "spec-ready" ? "completed" : "failed",
    updatedAt: result.generatedAt,
    promptPath: result.promptPath,
    outputPath: result.outputPath,
    artifacts: {
      specPath: result.specPath
    },
    session: {
      ...result.session,
      transportId: readScopedPhaseSession(paths, workId, "spec")?.tmuxSession ?? result.session.transportId
    }
  });
  return result;
}

export async function runSpecFeedbackWorker(paths: DevtaskPaths, workId: string): Promise<WorkSpecResult> {
  const current = readScopedPhaseSession(paths, workId, "spec");
  if (!current) {
    throw new DevtaskError(`No spec feedback session exists for ${workId}`);
  }
  const previous = readResumeSession(paths, workId, "spec", null);
  const prompt = fs.readFileSync(current.promptPath, "utf8");
  const result = await specWork(paths, workId, {
    resumeSession: previous.session,
    promptOverride: prompt
  });
  updateScopedPhaseSession(paths, workId, "spec", null, {
    status: result.status === "spec-ready" ? "completed" : "failed",
    updatedAt: result.generatedAt,
    promptPath: result.promptPath,
    outputPath: result.outputPath,
    artifacts: {
      specPath: result.specPath
    },
    session: {
      ...result.session,
      transportId: current.tmuxSession
    }
  });
  return result;
}

export async function runPlanWorker(paths: DevtaskPaths, workId: string): Promise<WorkPlanRecord> {
  const result = await planWork(paths, workId);
  updateScopedPhaseSession(paths, workId, "plan", null, {
    status: result.status === "planned" ? "completed" : "failed",
    updatedAt: result.finishedAt,
    promptPath: result.promptPath,
    outputPath: result.outputPath,
    artifacts: {
      planPath: result.planPath,
      graphPath: result.graphPath
    },
    session: {
      ...result.session,
      transportId: readScopedPhaseSession(paths, workId, "plan")?.tmuxSession ?? result.session.transportId
    }
  });
  return result;
}

export async function runPlanFeedbackWorker(paths: DevtaskPaths, workId: string): Promise<WorkPlanRecord> {
  const current = readScopedPhaseSession(paths, workId, "plan");
  if (!current) {
    throw new DevtaskError(`No plan feedback session exists for ${workId}`);
  }
  const previous = readResumeSession(paths, workId, "plan", null);
  const prompt = fs.readFileSync(current.promptPath, "utf8");
  const result = await planWork(paths, workId, {
    resumeSession: previous.session,
    promptOverride: prompt
  });
  updateScopedPhaseSession(paths, workId, "plan", null, {
    status: result.status === "planned" ? "completed" : "failed",
    updatedAt: result.finishedAt,
    promptPath: result.promptPath,
    outputPath: result.outputPath,
    artifacts: {
      planPath: result.planPath,
      graphPath: result.graphPath
    },
    session: {
      ...result.session,
      transportId: current.tmuxSession
    }
  });
  return result;
}

export async function runRepoPlanWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const item = getWorkItem(paths, workId);
  const graph = readWorkGraph(paths, workId);
  const graphTask = graph.tasks.find((entry) => entry.repoId === repoId);
  if (!graphTask) {
    throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
  }
  const repo = getWorkspaceRepo(paths, repoId);
  const record = await runWorkspaceRepoPlan(paths, item, graphTask, repo);
  updateScopedPhaseSession(paths, workId, "repo-plan", repoId, {
    status: record.status === "planned" ? "completed" : record.status === "blocked" ? "blocked" : "failed",
    updatedAt: new Date().toISOString(),
    artifacts: {
      planPath: record.planPath
    },
    session: {
      ...record.session,
      transportId: readScopedPhaseSession(paths, workId, "repo-plan", repoId)?.tmuxSession ?? record.session.transportId
    }
  });
}

export async function runRepoPlanFeedbackWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const current = readScopedPhaseSession(paths, workId, "repo-plan", repoId);
  if (!current) {
    throw new DevtaskError(`No repo-plan feedback session exists for ${workId}/${repoId}`);
  }
  const item = getWorkItem(paths, workId);
  const graph = readWorkGraph(paths, workId);
  const graphTask = graph.tasks.find((entry) => entry.repoId === repoId);
  if (!graphTask) {
    throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
  }
  const repo = getWorkspaceRepo(paths, repoId);
  const previous = readResumeSession(paths, workId, "repo-plan", repoId);
  const prompt = fs.readFileSync(current.promptPath, "utf8");
  const record = await runWorkspaceRepoPlan(paths, item, graphTask, repo, {
    resumeSession: previous.session,
    promptOverride: prompt
  });
  updateScopedPhaseSession(paths, workId, "repo-plan", repoId, {
    status: record.status === "planned" ? "completed" : record.status === "blocked" ? "blocked" : "failed",
    updatedAt: new Date().toISOString(),
    artifacts: {
      planPath: record.planPath
    },
    session: {
      ...record.session,
      transportId: current.tmuxSession,
      providerSessionId: record.session.providerSessionId,
      conversationId: record.session.conversationId,
      resumeTarget: record.session.resumeTarget
    }
  });
}

export async function runReviewWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const materialization = requireMaterialization(paths, workId);
  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
  }
  const latestCheck = readWorkResultSummary(paths, workId, "check");
  const latestVerify = readWorkResultSummary(paths, workId, "verify");
  const latestCi = readWorkResultSummary(paths, workId, "ci");
  const result = await runReviewAgent(paths, workId, task, readConfig(paths), { latestCheck, latestVerify, latestCi });
  const latest = getLatestWorkPhaseRun(paths, workId, "review", repoId);
  if (!latest) {
    throw new DevtaskError(`Review phase run was not recorded for ${workId}/${repoId}`);
  }
  updateScopedPhaseSession(paths, workId, "review", repoId, {
    status: result.status === "blocked" ? "blocked" : result.status === "failed" ? "failed" : "completed",
    updatedAt: latest.finishedAt,
    promptPath: latest.promptPath,
    outputPath: latest.outputPath,
    artifacts: latest.artifacts,
    taskId: latest.taskId,
    runId: latest.runId,
    session: {
      ...latest.session,
      transportId: readScopedPhaseSession(paths, workId, "review", repoId)?.tmuxSession ?? latest.session.transportId
    }
  });
}

export async function runReviewFeedbackWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const current = readScopedPhaseSession(paths, workId, "review", repoId);
  if (!current) {
    throw new DevtaskError(`No review feedback session exists for ${workId}/${repoId}`);
  }
  const materialization = requireMaterialization(paths, workId);
  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
  }
  const previous = readResumeSession(paths, workId, "review", repoId);
  const prompt = fs.readFileSync(current.promptPath, "utf8");
  const latestCheck = readWorkResultSummary(paths, workId, "check");
  const latestVerify = readWorkResultSummary(paths, workId, "verify");
  const latestCi = readWorkResultSummary(paths, workId, "ci");
  const result = await runReviewAgent(paths, workId, task, readConfig(paths), { latestCheck, latestVerify, latestCi }, {
    resumeSession: previous.session,
    promptOverride: prompt
  });
  const latest = getLatestWorkPhaseRun(paths, workId, "review", repoId);
  if (!latest) {
    throw new DevtaskError(`Review phase run was not recorded for ${workId}/${repoId}`);
  }
  updateScopedPhaseSession(paths, workId, "review", repoId, {
    status: result.status === "blocked" ? "blocked" : result.status === "failed" ? "failed" : "completed",
    updatedAt: latest.finishedAt,
    promptPath: latest.promptPath,
    outputPath: latest.outputPath,
    artifacts: latest.artifacts,
    taskId: latest.taskId,
    runId: latest.runId,
    session: {
      ...latest.session,
      transportId: current.tmuxSession
    }
  });
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

async function executeMaterializedTask(
  workspacePaths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number]
): Promise<ExecuteTaskResult> {
  const repoPaths = resolvePaths(task.repoPath);
  const storagePaths = taskStoragePaths(workspacePaths, task.repoPath);
  const metaPath = taskMetaPath(storagePaths, task.taskId);
  let meta = readTaskMeta(metaPath);
  const current = deriveExecutionStatus(meta);

  if (current.terminal) {
    meta = persistExecutionMeta(metaPath, {
      ...meta,
      status: current.status,
      resultSummary: current.summary,
      runtime: {
        state: "completed",
        reason: current.summary ?? `task ${current.status}`,
        lastObservedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    });
    await writeExecutePhaseRun(workspacePaths, workId, task, meta, current.status);
    const existingSession = readScopedPhaseSession(workspacePaths, workId, "execute", task.repoId);
    if (existingSession) {
      updateScopedPhaseSession(workspacePaths, workId, "execute", task.repoId, {
        status: current.status === "blocked" ? "blocked" : current.status === "failed" ? "failed" : "completed",
        updatedAt: meta.updatedAt,
        session: {
          ...existingSession.session,
          summary: meta.resultSummary,
          summaryIsFallback: true
        }
      });
    }
    return {
      repoId: task.repoId,
      taskId: task.taskId,
      status: current.status,
      action: "skipped",
      sessionName: meta.tmuxSession,
      summary: meta.resultSummary,
      worktreePath: task.worktreePath
    };
  }

  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    meta = persistExecutionMeta(metaPath, {
      ...meta,
      status: "running",
      runtime: {
        state: "alive",
        reason: "execution session is active",
        lastObservedAt: new Date().toISOString()
      }
    });
    await writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
    markExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, meta.tmuxSession!, {
      promptPath: meta.taskPath,
      outputPath: meta.statePath,
      resultPath: meta.resultPath,
      updatedAt: meta.updatedAt,
      summary: meta.resultSummary,
      provider: readConfig(workspacePaths).agent.provider,
      providerSessionId: meta.agentSessionId,
      conversationId: meta.agentThreadId
    });
    return {
      repoId: task.repoId,
      taskId: task.taskId,
      status: "running",
      action: "reattached",
      sessionName: meta.tmuxSession,
      summary: meta.resultSummary,
      worktreePath: task.worktreePath
    };
  }

  const previousStatus = meta.status;
  const sessionName = meta.tmuxSession ?? tmuxSessionName(repoPaths, task.taskId);
  launchExecutionSession(workspacePaths, task.repoId, sessionName, meta);
  if (!waitForTmuxSession(sessionName, { attempts: 5, intervalMs: 200 })) {
    throw new DevtaskError(`Execution session ${sessionName} failed to start for ${task.taskId}`);
  }

  meta = persistExecutionMeta(metaPath, {
    ...meta,
    status: "running",
    tmuxSession: sessionName,
    agentSessionMode: "direct",
    resultSummary: "execution session started",
    runtime: {
      state: "alive",
      reason: "execution session is active",
      lastObservedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  });
  await writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
  markExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, sessionName, {
    promptPath: meta.taskPath,
    outputPath: meta.statePath,
    resultPath: meta.resultPath,
    updatedAt: meta.updatedAt,
    summary: meta.resultSummary,
    provider: readConfig(workspacePaths).agent.provider,
    providerSessionId: meta.agentSessionId,
    conversationId: meta.agentThreadId
  });
  return {
    repoId: task.repoId,
    taskId: task.taskId,
    status: "running",
    action: previousStatus === "paused" || previousStatus === "running" ? "resumed" : "started",
    sessionName,
    summary: meta.resultSummary,
    worktreePath: task.worktreePath
  };
}

function launchExecutionSession(workspacePaths: DevtaskPaths, repoId: string, sessionName: string, meta: TaskMeta): void {
  const executionTaskPath = buildExecutionTaskPath(workspacePaths, repoId, meta);
  createBareSession(sessionName, meta.worktreePath);
  const scriptPath = writeLaunchScript([
    `cd ${shellEscape(meta.worktreePath)}`,
    `export DEVTASK_TASK_DIR=${shellEscape(path.dirname(meta.taskPath))}`,
    `export DEVTASK_TASK_PATH=${shellEscape(executionTaskPath)}`,
    `export DEVTASK_STATE_PATH=${shellEscape(meta.statePath)}`,
    `export DEVTASK_RESULT_PATH=${shellEscape(meta.resultPath)}`,
    `exec ${meta.command}`
  ].join("\n"));
  sendLaunchCommand(sessionName, `bash ${shellEscape(scriptPath)}`);
}

function buildExecutionTaskPath(workspacePaths: DevtaskPaths, repoId: string, meta: TaskMeta): string {
  const memory = collectPhaseMemory(workspacePaths, "implementation", { repoId });
  if (!memory) {
    return meta.taskPath;
  }
  const executionTaskPath = path.join(path.dirname(meta.taskPath), "task.execute.md");
  const original = readTextIfExists(meta.taskPath).trim();
  fs.writeFileSync(executionTaskPath, [original, "", memory].join("\n"));
  return executionTaskPath;
}

function deriveExecutionStatus(meta: TaskMeta): {
  status: ExecuteTaskResult["status"];
  terminal: boolean;
  summary: string | null;
} {
  const result = readTaskResult(meta.resultPath);
  if (result.status === "done") {
    return { status: "done", terminal: true, summary: result.summary };
  }
  if (result.status === "blocked") {
    return { status: "blocked", terminal: true, summary: result.summary };
  }
  if (result.status === "failed") {
    return { status: "failed", terminal: true, summary: result.summary };
  }
  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    return { status: "running", terminal: false, summary: meta.resultSummary };
  }
  if (meta.status === "paused") {
    return { status: "paused", terminal: false, summary: meta.resultSummary };
  }
  return { status: "paused", terminal: false, summary: meta.resultSummary };
}

function readTaskResult(resultPath: string): { status: string; summary: string | null } {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown; reason?: unknown; summary?: unknown };
    const status = typeof value.status === "string" ? value.status : "pending";
    const summarySource = typeof value.reason === "string" ? value.reason : typeof value.summary === "string" ? value.summary : null;
    return {
      status,
      summary: summarySource?.trim() || null
    };
  } catch {
    return {
      status: "pending",
      summary: null
    };
  }
}

function summarizeExecuteWorkStatus(tasks: ExecuteTaskResult[]): import("../storage/work-store.js").WorkItemStatus {
  if (tasks.some((task) => task.status === "failed")) {
    return "failed";
  }
  if (tasks.some((task) => task.status === "blocked")) {
    return "blocked";
  }
  if (tasks.every((task) => task.status === "done")) {
    return "review-ready";
  }
  return "executing";
}

function summarizeReviewWorkStatus(tasks: ReviewTaskResult[]): import("../storage/work-store.js").WorkItemStatus {
  if (tasks.some((task) => task.status === "failed" || task.status === "blocked")) {
    return "blocked";
  }
  return "review-ready";
}

function persistExecutionMeta(metaPath: string, meta: TaskMeta): TaskMeta {
  writeTaskMeta(metaPath, meta);
  return readTaskMeta(metaPath);
}

async function writeExecutePhaseRun(
  workspacePaths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number],
  meta: TaskMeta,
  status: string
): Promise<void> {
  const provider = readConfig(workspacePaths).agent.provider;
  const runId = newRunId();
  writePhaseRunRecord(workItemRepoPhaseRunsDir(workspacePaths, workId, "execute", task.repoId), {
    schemaVersion: 1,
    phase: "execute",
    runId,
    workId,
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    promptPath: meta.taskPath,
    outputPath: meta.statePath,
    startedAt: meta.updatedAt,
    finishedAt: meta.updatedAt,
    session: {
      provider,
      transportId: meta.tmuxSession,
      providerSessionId: meta.agentSessionId,
      conversationId: meta.agentThreadId,
      resumeTarget: meta.agentSessionId,
      summary: meta.resultSummary,
      summaryIsFallback: true,
      storageRoot: null,
      transcriptPath: null
    },
    artifacts: {
      taskPath: meta.taskPath,
      statePath: meta.statePath,
      resultPath: meta.resultPath
    },
    exitCode: null
  });
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(workspacePaths, workId), {
    schemaVersion: 1,
    runId,
    workId,
    phase: "execute",
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    startedAt: meta.updatedAt,
    finishedAt: meta.updatedAt,
    session: {
      provider,
      transportId: meta.tmuxSession,
      providerSessionId: meta.agentSessionId,
      conversationId: meta.agentThreadId,
      resumeTarget: meta.agentSessionId,
      summary: meta.resultSummary,
      summaryIsFallback: true,
      storageRoot: null,
      transcriptPath: null
    }
  });
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    const repoPaths = resolvePaths(task.repoPath);
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

function requireWorkSpec(paths: DevtaskPaths, workId: string): string {
  const specPath = workItemSpecPath(paths, workId);
  if (!fs.existsSync(specPath) || fs.readFileSync(specPath, "utf8").trim().length === 0) {
    throw new Error(`Work spec is not ready for ${workId}. Run devtask work spec ${workId} first.`);
  }
  return specPath;
}

function writeWorkResult(paths: DevtaskPaths, workId: string, name: string, value: unknown): void {
  const dir = workItemResultsDir(paths, workId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

function readLatestPhaseRunStatus(dir: string): { status: string; outputPath: string } | null {
  try {
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    const latest = files.at(-1);
    if (!latest) {
      return null;
    }
    const value = JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as { status?: unknown; outputPath?: unknown };
    return typeof value.status === "string" && typeof value.outputPath === "string"
      ? { status: value.status, outputPath: value.outputPath }
      : null;
  } catch {
    return null;
  }
}

function persistSharedRepoPlan(paths: DevtaskPaths, workId: string, repoId: string, sourcePlanPath: string): void {
  const plan = readTextIfExists(sourcePlanPath).trim();
  if (!plan) {
    return;
  }
  const target = workItemRepoPlanPath(paths, workId, repoId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${plan}\n`);
}

async function runWorkspaceRepoPlan(
  paths: DevtaskPaths,
  item: WorkItem,
  graphTask: import("../work-materializer.js").WorkGraphTask,
  repo: import("../storage/workspace-repos.js").WorkspaceRepo,
  options: {
    onStart?: (start: PlanAgentStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  } = {}
): Promise<{
  status: RepoPlanTaskResult["status"];
  planPath: string;
  outputPath: string;
  session: AgentSessionRef;
}> {
  const config = readConfig(paths);
  const repoPaths = resolvePaths(repo.repoPath);
  const phaseRunsDir = workItemRepoPhaseRunsDir(paths, item.id, "repo-plan", repo.id);
  fs.mkdirSync(phaseRunsDir, { recursive: true });
  const runId = newRunId();
  const promptPath = path.join(phaseRunsDir, `${runId}.prompt.md`);
  const outputPath = path.join(phaseRunsDir, `${runId}.md`);
  const runtimeArtifactPrefix = path.join(repoPaths.root, `.devtask_repo_plan_${runId}`);
  const runtimePlanPath = `${runtimeArtifactPrefix}.md`;
  const runtimeStatePath = `${runtimeArtifactPrefix}.state.md`;
  const resultPath = `${runtimeArtifactPrefix}.result.json`;
  const finalPlanPath = workItemRepoPlanPath(paths, item.id, repo.id);
  const taskDocument = buildWorkspaceRepoPlanTask(item, graphTask, repo);
  const stateDocument = `# State: ${graphTask.id}\n\n## Progress\n- Repo-plan phase for work ${item.id}\n`;
  const prompt = options.promptOverride?.trim()
    ? options.promptOverride.trim()
    : buildRepoPlanPrompt(
        { id: graphTask.id },
        runtimePlanPath,
        finalPlanPath,
        taskDocument,
        stateDocument,
        collectPhaseMemory(paths, "planning", { repoId: repo.id })
      );
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const startOptions = {
    workspacePath: repoPaths.root,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: [workItemDir(paths, item.id), repo.scope ? path.join(repo.repoPath, repo.scope) : repo.repoPath],
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: workItemDir(paths, item.id),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_PLAN_PATH: runtimePlanPath,
      DEVTASK_STATE_PATH: runtimeStatePath,
      DEVTASK_RESULT_PATH: resultPath
    }
  } as const;
  const runner = createDefaultAgentRunner(config);
  const command = options.resumeSession
    ? (runner.buildResumeCommand?.(options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }) ?? "agent-resume")
    : (runner.buildStartCommand?.(startOptions) ?? "agent-run");
  options.onStart?.({ command, promptPath, outputPath, planPath: finalPlanPath });
  const startedAt = new Date().toISOString();
  const result = options.resumeSession
    ? await resumeAgentPrompt(runner, options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }, prompt, {
        outputPath,
        onOutput: options.onStdout
      })
    : await runAgentPrompt(runner, startOptions, prompt, {
        outputPath,
        onOutput: options.onStdout
      });
  const finishedAt = new Date().toISOString();
  persistSharedRepoPlan(paths, item.id, repo.id, runtimePlanPath);
  const blocked = readTaskResult(resultPath).status === "blocked";
  removeIfExists(runtimePlanPath);
  removeIfExists(runtimeStatePath);
  removeIfExists(resultPath);
  const status: RepoPlanTaskResult["status"] =
    result.status === "completed" && readTextIfExists(finalPlanPath).trim()
      ? blocked ? "blocked" : "planned"
      : "failed";
  writePhaseRunRecord(phaseRunsDir, {
    schemaVersion: 1,
    phase: "repo-plan",
    runId,
    workId: item.id,
    repoId: repo.id,
    taskId: graphTask.id,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      planPath: finalPlanPath
    },
    exitCode: result.status === "completed" ? 0 : null
  });
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(paths, item.id), {
    schemaVersion: 1,
    runId,
    workId: item.id,
    phase: "repo-plan",
    repoId: repo.id,
    taskId: graphTask.id,
    status,
    startedAt,
    finishedAt,
    session: result.session
  });

  return {
    status,
    planPath: finalPlanPath,
    outputPath,
    session: result.session
  };
}

function buildWorkspaceRepoPlanTask(
  item: WorkItem,
  graphTask: import("../work-materializer.js").WorkGraphTask,
  repo: import("../storage/workspace-repos.js").WorkspaceRepo
): string {
  return [
    `# Task ${graphTask.id}`,
    "",
    "## Goal",
    graphTask.goal,
    "",
    "## Work Item",
    `- id: ${item.id}`,
    `- title: ${item.source.title}`,
    `- source artifact: ${item.source.artifact}`,
    `- repo id: ${repo.id}`,
    `- repo path: ${repo.repoPath}`,
    `- repo scope: ${repo.scope ?? "."}`,
    "",
    "## Ownership",
    ...(graphTask.owns.length > 0 ? graphTask.owns.map((entry) => `- ${entry}`) : ["- none"]),
    "",
    "## Dependencies",
    ...(graphTask.dependencies.length > 0
      ? graphTask.dependencies.map((dependency) => `- ${dependency.task} (${dependency.type})${dependency.reason ? `: ${dependency.reason}` : ""}`)
      : ["- none"])
  ].join("\n");
}

function readWorkResultSummary(paths: DevtaskPaths, workId: string, name: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(`${workItemResultsDir(paths, workId)}/${name}.json`, "utf8")) as {
      tasks?: Array<{ status?: unknown }>;
    };
    if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
      return null;
    }
    const statuses = value.tasks
      .map((task) => (typeof task.status === "string" ? task.status : null))
      .filter((status): status is string => Boolean(status));
    return statuses.length > 0 ? statuses.join(",") : null;
  } catch {
    return null;
  }
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

async function readGitStatusShort(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function readGitDiffStat(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["diff", "--stat"], { cwd: worktreePath });
  return result.stdout.trim();
}

async function runSpecAgent(
  paths: DevtaskPaths,
  item: WorkItem,
  config: DevtaskConfig,
  options: {
    onStart?: (start: { command: string; promptPath: string; outputPath: string; specPath: string }) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  }
): Promise<WorkSpecResult> {
  const specPath = workItemSpecPath(paths, item.id);
  const runsDir = workItemSpecRunsDir(paths, item.id);
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = Date.now().toString();
  const promptPath = `${runsDir}/${runId}.prompt.md`;
  const outputPath = `${runsDir}/${runId}.md`;
  const prompt = options.promptOverride?.trim() ? options.promptOverride.trim() : buildSpecPrompt(item, specPath);
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const runner = createDefaultAgentRunner(config);
  const startOptions = {
    workspacePath: paths.root,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: [path.dirname(item.source.artifact)],
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: workItemDir(paths, item.id),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_WORK_SPEC_PATH: specPath
    }
  } as const;
  const command = options.resumeSession
    ? (runner.buildResumeCommand?.(options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }) ?? "agent-resume")
    : (runner.buildStartCommand?.(startOptions) ?? "agent-run");
  options.onStart?.({ command, promptPath, outputPath, specPath });
  const startedAt = new Date().toISOString();
  const result = options.resumeSession
    ? await resumeAgentPrompt(runner, options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }, prompt, {
        outputPath,
        onOutput: (chunk) => {
          options.onStdout?.(chunk);
        }
      })
    : await runAgentPrompt(runner, startOptions, prompt, {
        outputPath,
        onOutput: (chunk) => {
          options.onStdout?.(chunk);
        }
      });
  const finishedAt = new Date().toISOString();
  const currentSpec = readTextIfExists(specPath).trim();
  const status: WorkSpecResult["status"] =
    result.status === "completed" && currentSpec.length > 0 ? "spec-ready" : "failed";
  writePhaseRunRecord(workItemPhaseRunsDir(paths, item.id, "spec"), {
    schemaVersion: 1,
    phase: "spec",
    runId,
    workId: item.id,
    repoId: null,
    taskId: null,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      specPath
    },
    exitCode: result.status === "completed" ? 0 : null
  });
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(paths, item.id), {
    schemaVersion: 1,
    runId,
    workId: item.id,
    phase: "spec",
    repoId: null,
    taskId: null,
    status,
    startedAt,
    finishedAt,
    session: result.session
  });
  return {
    runId,
    workId: item.id,
    status,
    specPath,
    promptPath,
    outputPath,
    exitCode: result.status === "completed" ? 0 : null,
    generatedAt: finishedAt,
    session: result.session
  };
}

async function runReviewAgent(
  paths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number],
  config: DevtaskConfig,
  signals: { latestCheck: string | null; latestVerify: string | null; latestCi: string | null },
  options: {
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  } = {}
): Promise<ReviewTaskResult> {
  const storagePaths = taskStoragePaths(paths, task.repoPath);
  const meta = readTaskMeta(taskMetaPath(storagePaths, task.taskId));
  const clean = !(await hasUncommittedChanges(task.worktreePath));
  const commits = await countBranchCommits(task.worktreePath).catch(() => 0);
  const changedFiles = await readGitStatusShort(task.worktreePath);
  const diffStat = await readGitDiffStat(task.worktreePath);
  const reviewDir = workItemReviewDir(paths, workId);
  fs.mkdirSync(reviewDir, { recursive: true });
  const reviewPath = `${reviewDir}/${task.repoId}.md`;
  const resultPath = `${reviewDir}/${task.repoId}.json`;
  const promptPath = `${reviewDir}/${task.repoId}.prompt.md`;
  const outputPath = `${reviewDir}/${task.repoId}.output.md`;
  const prompt = options.promptOverride?.trim()
    ? options.promptOverride.trim()
    : buildReviewPrompt(
        task,
        meta,
        reviewPath,
        resultPath,
        {
          clean,
          commits,
          changedFiles,
          diffStat,
          latestCheck: signals.latestCheck,
          latestVerify: signals.latestVerify,
          latestCi: signals.latestCi
        },
        collectPhaseMemory(paths, "review", { repoId: task.repoId })
      );
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const runner = createDefaultAgentRunner(config);
  const startOptions = {
    workspacePath: task.worktreePath,
    model: config.codex.model,
    fullAuto: false,
    skipGitRepoCheck: true,
    addDirs: [workItemDir(paths, workId)],
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: workItemDir(paths, workId),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_REVIEW_PATH: reviewPath,
      DEVTASK_REVIEW_RESULT_PATH: resultPath
    }
  } as const;
  const startedAt = new Date().toISOString();
  const execResult = options.resumeSession
    ? await resumeAgentPrompt(runner, options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }, prompt, {
        outputPath
      })
    : await runAgentPrompt(runner, startOptions, prompt, {
        outputPath
      });

  const parsed = readReviewResult(resultPath);
  const status: ReviewTaskResult["status"] =
    execResult.status !== "completed" ? "failed" : parsed?.status ?? "failed";
  const runId = newRunId();
  const finishedAt = new Date().toISOString();
  writePhaseRunRecord(workItemRepoPhaseRunsDir(paths, workId, "review", task.repoId), {
    schemaVersion: 1,
    phase: "review",
    runId,
    workId,
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: execResult.session,
    artifacts: {
      reviewPath,
      resultPath
    },
    exitCode: execResult.status === "completed" ? 0 : null
  });
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(paths, workId), {
    schemaVersion: 1,
    runId,
    workId,
    phase: "review",
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    startedAt,
    finishedAt,
    session: execResult.session
  });
  return {
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    branch: task.branch,
    worktreePath: task.worktreePath,
    reviewPath,
    resultPath,
    prUrl: meta.prUrl,
    summary: parsed?.summary ?? "review result not produced",
    findings: parsed?.findings ?? [],
    latestCheck: signals.latestCheck,
    latestVerify: signals.latestVerify,
    latestCi: signals.latestCi
  };
}

function readReviewResult(filePath: string): { status: ReviewTaskResult["status"]; summary: string; findings: string[] } | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      status?: unknown;
      summary?: unknown;
      findings?: unknown;
    };
    if (
      (value.status === "approved" || value.status === "findings" || value.status === "blocked") &&
      typeof value.summary === "string"
    ) {
      return {
        status: value.status,
        summary: value.summary,
        findings: Array.isArray(value.findings)
          ? value.findings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : []
      };
    }
  } catch {
    // ignore malformed review result
  }
  return null;
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
