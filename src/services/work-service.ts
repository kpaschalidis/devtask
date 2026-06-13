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
  workItemPlanRunsDir,
  workItemRepoPlanPath,
  workItemResultsDir,
  workItemReviewDir,
  phaseRunDir,
  workItemSpecPath,
  workItemSpecRunsDir
} from "../infra/paths.js";
import { createDefaultAgentRunner, runAgentPrompt } from "../agent.js";
import { writePhaseRunRecord, readRunningPhaseRun, writeRunningPhaseRun, updateRunningPhaseRun, type PhaseRun } from "../infra/phase-run.js";
import { newRunId } from "../infra/run-record.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import { readWorkGraph } from "../work-materializer.js";
import type { PlanRecord } from "../repo-plan.js";
import {
  readLatestWorkPlanRecord,
  workPlanAddDirsForTest,
  type WorkPlanRecord
} from "../global-plan.js";
import {
  createJiraWorkItem,
  createManualWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type WorkItem
} from "../storage/work-store.js";
import { getWorkspaceRepo, listWorkspaceRepos } from "../storage/workspace-repos.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../adapters/jira.js";
import { updateRecentWork } from "../storage/global-index.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { runCommand } from "../infra/process-runner.js";
import {
  attachTmuxSession,
  createBareSession,
  killTmuxSession,
  sendLaunchCommand,
  sendToTmuxSessionWithConfirmation,
  startPipePane,
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
import { buildGlobalPlanPrompt } from "../prompts/global-plan.js";
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

export function attachWorkPhase(paths: DevtaskPaths, phase: "spec" | "plan", workId: string): Promise<void>;
export function attachWorkPhase(paths: DevtaskPaths, phase: "repo-plan" | "review" | "execute", workId: string, repoId: string): Promise<void>;
export async function attachWorkPhase(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review" | "execute",
  workId: string,
  repoId?: string
): Promise<void> {
  const scopeRepoId = repoId ?? null;
  const dir = phaseRunDir(paths, workId, phase, scopeRepoId);
  const current = readRunningPhaseRun(dir);
  const isLive = current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "");
  if (isLive) {
    attachTmuxSession(current!.tmuxSession!);
    return;
  }
  if (phase === "execute") {
    const scope = scopeRepoId ? `${workId}/${scopeRepoId}` : workId;
    if (!current) throw new DevtaskError(`No execute session exists for ${scope}`);
    throw new DevtaskError(`The latest execute session for ${scope} is not running`);
  }
  const launched = await startInteractivePhaseResumeSession(paths, phase, workId, scopeRepoId);
  attachTmuxSession(launched.tmuxSession);
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
    const dir = phaseRunDir(paths, workId, "execute", repoId);
    const run = readRunningPhaseRun(dir);
    const scope = repoId ? `${workId}/${repoId}` : workId;
    if (!run || run.status !== "running" || !tmuxSessionExists(run.tmuxSession ?? "")) {
      throw new DevtaskError(`No running execute session for ${scope}`);
    }
    return sendToTmuxSessionWithConfirmation(run.tmuxSession!, message, { lines: 60 });
  }
  return startPhaseFeedbackSession(paths, phase, workId, message, repoId);
}

export function freshExecuteWork(paths: DevtaskPaths, workId: string, repoId: string): void {
  freshInteractiveExecuteSession(paths, workId, repoId);
}

function launchInteractiveResume(cwd: string, tmuxSession: string, command: string): void {
  if (tmuxSessionExists(tmuxSession)) {
    killTmuxSession(tmuxSession);
  }
  const scriptLines = [
    `cd ${shellEscape(cwd)}`,
    command
  ];
  const scriptPath = writeLaunchScript(scriptLines.join("\n"));
  startTmuxSession(tmuxSession, ["bash", scriptPath], cwd);
  if (!waitForTmuxSession(tmuxSession, { attempts: 5, intervalMs: 200 })) {
    throw new DevtaskError(`Phase session ${tmuxSession} failed to start`);
  }
}

function buildManagedPhaseCompletionCommand(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review",
  workId: string,
  repoId: string | null,
  runId: string
): string {
  const args = repoId
    ? ["work", "_phase-finalize-hook", phase, workId, runId, repoId]
    : ["work", "_phase-finalize-hook", phase, workId, runId];
  return [
    `export DEVTASK_WORKSPACE_ROOT=${shellEscape(paths.root)}`,
    `exec ${buildDevtaskCommand(args)}`
  ].join("\n");
}

async function startInteractivePhaseFreshSession(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review",
  workId: string,
  repoId: string | null,
  scope: {
    cwd: string;
    tmuxSession: string;
    promptPath: string;
    outputPath: string;
    taskId: string | null;
    artifacts: Record<string, string>;
    prompt: string;
    startOptions: Parameters<NonNullable<ReturnType<typeof createDefaultAgentRunner>["buildInteractiveStartCommand"]>>[0];
  }
): Promise<PhaseLaunchResult> {
  ensureNoLivePhaseSession(paths, workId, phase, repoId);
  const config = readConfig(paths);
  const runner = createDefaultAgentRunner(config);
  const start = await runner.buildInteractiveStartCommand?.(scope.startOptions, scope.prompt);
  if (!start) {
    throw new DevtaskError(`Provider ${config.agent.provider} does not support interactive ${phase} sessions`);
  }

  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${scope.prompt}\n`);
  launchInteractiveResume(scope.cwd, scope.tmuxSession, start.command);
  await startPipePane(scope.tmuxSession, scope.outputPath);
  const startedAt = new Date().toISOString();
  writeRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    runId: path.basename(scope.promptPath).replace(/\.prompt\.md$/, ""),
    tmuxSession: scope.tmuxSession,
    startedAt,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath,
    artifacts: scope.artifacts,
    session: {
      ...start.session,
      transportId: scope.tmuxSession,
      summary: `${phase} session started`,
      summaryIsFallback: true
    }
  });
  return {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    status: "started",
    tmuxSession: scope.tmuxSession,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath
  };
}

async function startPhaseFeedbackSession(
  paths: DevtaskPaths,
  phase: "spec" | "plan" | "repo-plan" | "review",
  workId: string,
  feedback: string,
  repoId: string | null
): Promise<PhaseLaunchResult> {
  return startInteractivePhaseResumeSession(
    paths,
    phase,
    workId,
    repoId,
    buildPhaseFeedbackPrompt(phase, feedback, readResumeSession(paths, workId, phase, repoId).session),
    true
  );
}

async function startInteractivePhaseResumeSession(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  repoId: string | null,
  prompt?: string,
  trackCompletion = false
): Promise<PhaseLaunchResult> {
  ensureNoLivePhaseSession(paths, workId, phase, repoId);
  const previous = readResumeSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const config = readConfig(paths);
  const runner = createDefaultAgentRunner(config);
  const scope = PHASE_CONFIGS[phase].resumeScope(paths, workId, repoId, runId);
  const completionCommand = trackCompletion ? buildManagedPhaseCompletionCommand(paths, phase, workId, repoId, runId) : null;
  runner.installCompletionHook?.(previous.session, completionCommand);
  const command = runner.buildInteractiveResumeCommand?.(previous.session, {
    workspacePath: scope.cwd,
    model: config.codex.model ?? null,
    prompt: prompt ?? null,
    managedCompletionCommand: completionCommand
  });
  if (!command) {
    throw new DevtaskError(`Provider ${previous.session.provider} does not support interactive resume for ${phase}`);
  }
  const startedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${prompt ?? buildPhaseResumePrompt(phase, previous.session)}\n`);
  launchInteractiveResume(scope.cwd, scope.tmuxSession, command);
  await startPipePane(scope.tmuxSession, scope.outputPath);
  writeRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    runId,
    tmuxSession: scope.tmuxSession,
    startedAt,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath,
    artifacts: scope.artifacts,
    session: {
      ...previous.session,
      transportId: scope.tmuxSession,
      summary: `${phase} interactive resume session started`,
      summaryIsFallback: true
    }
  });
  return { phase, workId, repoId, taskId: scope.taskId, status: "started", tmuxSession: scope.tmuxSession, promptPath: scope.promptPath, outputPath: scope.outputPath };
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

function buildPhaseResumePrompt(
  phase: "spec" | "plan" | "repo-plan" | "review",
  session: AgentSessionRef
): string {
  return [
    `Continue the ${phase} task using the existing ${session.provider} session context.`,
    "",
    "Review the current phase artifacts and continue the session from where it left off."
  ].join("\n");
}

function hasResumeContext(session: AgentSessionRef): boolean {
  return Object.values(session.resumeContext).some((v) => v !== null);
}

function readResumeSession(
  paths: DevtaskPaths,
  workId: string,
  phase: "spec" | "plan" | "repo-plan" | "review",
  repoId: string | null
): { session: AgentSessionRef; taskId: string | null } {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (current && hasResumeContext(current.session)) {
    return {
      session: current.session,
      taskId: current.taskId
    };
  }

  const latest = getLatestWorkPhaseRun(paths, workId, phase, repoId ?? undefined);
  if (latest && hasResumeContext(latest.session)) {
    return {
      session: latest.session,
      taskId: latest.taskId
    };
  }

  throw new DevtaskError(`No resumable ${phase} session exists for ${repoId ? `${workId}/${repoId}` : workId}`);
}

type InteractivePhase = "spec" | "plan" | "repo-plan" | "review";

interface PhaseScope {
  tmuxSession: string;
  cwd: string;
  promptPath: string;
  outputPath: string;
  taskId: string | null;
  artifacts: Record<string, string>;
}

interface PhaseFreshScope {
  scope: PhaseScope;
  prompt: string;
  startOptions: Parameters<NonNullable<ReturnType<typeof createDefaultAgentRunner>["buildInteractiveStartCommand"]>>[0];
}

interface PhaseConfig {
  resumeScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string): PhaseScope;
  freshScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string): Promise<PhaseFreshScope>;
  workspacePath(paths: DevtaskPaths, workId: string, repoId: string | null): string;
  finalize(
    paths: DevtaskPaths,
    workId: string,
    repoId: string | null,
    sessionRecord: PhaseRun,
    session: AgentSessionRef,
    finishedAt: string
  ): Promise<{ status: string; artifacts: Record<string, string> }>;
}

const PHASE_CONFIGS: Record<InteractivePhase, PhaseConfig> = {
  spec: {
    resumeScope(paths, workId, _repoId, runId) {
      return {
        tmuxSession: tmuxSessionName(paths, `spec-${workId}`),
        cwd: paths.root,
        promptPath: path.join(workItemSpecRunsDir(paths, workId), `${runId}.prompt.md`),
        outputPath: path.join(workItemSpecRunsDir(paths, workId), `${runId}.md`),
        taskId: null,
        artifacts: { specPath: workItemSpecPath(paths, workId) }
      };
    },
    async freshScope(paths, workId, _repoId, runId) {
      const item = getWorkItem(paths, workId);
      const config = readConfig(paths);
      const runsDir = workItemSpecRunsDir(paths, workId);
      const promptPath = `${runsDir}/${runId}.prompt.md`;
      const outputPath = `${runsDir}/${runId}.md`;
      const specPath = workItemSpecPath(paths, workId);
      return {
        scope: {
          tmuxSession: tmuxSessionName(paths, `spec-${workId}`),
          cwd: paths.root,
          promptPath,
          outputPath,
          taskId: null,
          artifacts: { specPath }
        },
        prompt: buildSpecPrompt(item, specPath),
        startOptions: {
          workspacePath: paths.root,
          model: config.codex.model,
          fullAuto: config.codex.fullAuto,
          skipGitRepoCheck: true,
          addDirs: [path.dirname(item.source.artifact)],
          managedCompletionCommand: buildManagedPhaseCompletionCommand(paths, "spec", workId, null, runId),
          env: { ...process.env, DEVTASK_TASK_DIR: workItemDir(paths, workId), DEVTASK_TASK_PATH: promptPath, DEVTASK_WORK_SPEC_PATH: specPath }
        }
      };
    },
    workspacePath(paths) { return paths.root; },
    async finalize(paths, workId, _repoId, sessionRecord, session, finishedAt) {
      const specPath = sessionRecord.artifacts.specPath ?? workItemSpecPath(paths, workId);
      const status = isFreshArtifactSince(specPath, sessionRecord.startedAt) ? "spec-ready" : "failed";
      writeWorkResult(paths, workId, "spec", {
        runId: sessionRecord.runId,
        workId,
        status,
        specPath,
        promptPath: sessionRecord.promptPath,
        outputPath: sessionRecord.outputPath,
        exitCode: status === "spec-ready" ? 0 : null,
        generatedAt: finishedAt,
        session
      } satisfies WorkSpecResult);
      updateWorkItemStatus(paths, workId, status === "spec-ready" ? "spec-ready" : "failed");
      await updateRecentWork(paths, getWorkItem(paths, workId));
      return { status, artifacts: { specPath } };
    }
  },
  plan: {
    resumeScope(paths, workId, _repoId, runId) {
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
    },
    async freshScope(paths, workId, _repoId, runId) {
      requireWorkSpec(paths, workId);
      const config = readConfig(paths);
      const item = getWorkItem(paths, workId);
      const repos = listWorkspaceRepos(paths);
      const runsDir = workItemPlanRunsDir(paths, workId);
      const promptPath = path.join(runsDir, `${runId}.prompt.md`);
      const outputPath = path.join(runsDir, `${runId}.md`);
      const planPath = path.join(workItemDir(paths, workId), "plan.md");
      const graphPath = path.join(workItemDir(paths, workId), "graph.json");
      return {
        scope: {
          tmuxSession: tmuxSessionName(paths, `plan-${workId}`),
          cwd: paths.root,
          promptPath,
          outputPath,
          taskId: null,
          artifacts: { planPath, graphPath }
        },
        prompt: buildGlobalPlanPrompt(paths, item, repos, planPath, graphPath, workItemSpecPath(paths, workId), collectPhaseMemory(paths, "planning")),
        startOptions: {
          workspacePath: paths.root,
          model: config.codex.model,
          fullAuto: config.codex.fullAuto,
          skipGitRepoCheck: true,
          addDirs: workPlanAddDirsForTest(item, repos),
          managedCompletionCommand: buildManagedPhaseCompletionCommand(paths, "plan", workId, null, runId),
          env: { ...process.env, DEVTASK_TASK_DIR: workItemDir(paths, workId), DEVTASK_TASK_PATH: promptPath, DEVTASK_WORK_PLAN_PATH: planPath, DEVTASK_WORK_GRAPH_PATH: graphPath }
        }
      };
    },
    workspacePath(paths) { return paths.root; },
    async finalize(paths, workId, _repoId, sessionRecord, session, finishedAt) {
      const planPath = sessionRecord.artifacts.planPath ?? path.join(workItemDir(paths, workId), "plan.md");
      const graphPath = sessionRecord.artifacts.graphPath ?? path.join(workItemDir(paths, workId), "graph.json");
      const status: WorkPlanRecord["status"] =
        isFreshArtifactSince(planPath, sessionRecord.startedAt) && isFreshGraphSince(graphPath, sessionRecord.startedAt)
          ? "planned"
          : "failed";
      const record: WorkPlanRecord = {
        schemaVersion: 1,
        phase: "plan",
        planId: sessionRecord.runId,
        workId,
        status,
        command: "interactive-session",
        promptPath: sessionRecord.promptPath,
        outputPath: sessionRecord.outputPath,
        planPath,
        graphPath,
        startedAt: sessionRecord.startedAt,
        finishedAt,
        exitCode: status === "planned" ? 0 : null,
        session
      };
      fs.mkdirSync(workItemPlanRunsDir(paths, workId), { recursive: true });
      fs.writeFileSync(path.join(workItemPlanRunsDir(paths, workId), `${sessionRecord.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      updateWorkItemStatus(paths, workId, status === "planned" ? "planned" : "failed");
      await updateRecentWork(paths, getWorkItem(paths, workId));
      return { status, artifacts: { planPath, graphPath } };
    }
  },
  "repo-plan": {
    resumeScope(paths, workId, repoId, runId) {
      if (!repoId) throw new DevtaskError("repo-plan resume requires a repo id");
      const graph = readWorkGraph(paths, workId);
      const graphTask = graph.tasks.find((t) => t.repoId === repoId);
      if (!graphTask) throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
      const repo = getWorkspaceRepo(paths, repoId);
      const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
      return {
        tmuxSession: tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`),
        cwd: repo.repoPath,
        promptPath: path.join(phaseDir, `${runId}.prompt.md`),
        outputPath: path.join(phaseDir, `${runId}.md`),
        taskId: graphTask.id,
        artifacts: { planPath: workItemRepoPlanPath(paths, workId, repoId) }
      };
    },
    async freshScope(paths, workId, repoId, runId) {
      if (!repoId) throw new DevtaskError("repo-plan requires a repo id");
      const graph = readWorkGraph(paths, workId);
      const graphTask = graph.tasks.find((entry) => entry.repoId === repoId);
      if (!graphTask) throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
      const repo = getWorkspaceRepo(paths, repoId);
      const config = readConfig(paths);
      const repoPaths = resolvePaths(repo.repoPath);
      const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
      const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
      const outputPath = path.join(phaseDir, `${runId}.md`);
      const runtimePrefix = path.join(repoPaths.root, `.devtask_repo_plan_${runId}`);
      const runtimePlanPath = `${runtimePrefix}.md`;
      const runtimeStatePath = `${runtimePrefix}.state.md`;
      const resultPath = `${runtimePrefix}.result.json`;
      return {
        scope: {
          tmuxSession: tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`),
          cwd: repo.repoPath,
          promptPath,
          outputPath,
          taskId: graphTask.id,
          artifacts: { planPath: workItemRepoPlanPath(paths, workId, repoId), runtimePlanPath, runtimeStatePath, resultPath }
        },
        prompt: buildRepoPlanPrompt(
          { id: graphTask.id },
          runtimePlanPath,
          workItemRepoPlanPath(paths, workId, repoId),
          buildWorkspaceRepoPlanTask(getWorkItem(paths, workId), graphTask, repo),
          `# State: ${graphTask.id}\n\n## Progress\n- Repo-plan phase for work ${workId}\n`,
          collectPhaseMemory(paths, "planning", { repoId })
        ),
        startOptions: {
          workspacePath: repoPaths.root,
          model: config.codex.model,
          fullAuto: config.codex.fullAuto,
          skipGitRepoCheck: true,
          addDirs: [workItemDir(paths, workId), repo.scope ? path.join(repo.repoPath, repo.scope) : repo.repoPath],
          managedCompletionCommand: buildManagedPhaseCompletionCommand(paths, "repo-plan", workId, repoId, runId),
          env: { ...process.env, DEVTASK_TASK_DIR: workItemDir(paths, workId), DEVTASK_TASK_PATH: promptPath, DEVTASK_PLAN_PATH: runtimePlanPath, DEVTASK_STATE_PATH: runtimeStatePath, DEVTASK_RESULT_PATH: resultPath }
        }
      };
    },
    workspacePath(paths, _workId, repoId) {
      if (!repoId) throw new DevtaskError("repo-plan requires a repo id");
      return getWorkspaceRepo(paths, repoId).repoPath;
    },
    async finalize(paths, workId, repoId, sessionRecord, _session, _finishedAt) {
      if (!repoId) throw new DevtaskError("repo-plan finalizer requires a repo id");
      const planPath = sessionRecord.artifacts.planPath ?? workItemRepoPlanPath(paths, workId, repoId);
      const runtimePlanPath = sessionRecord.artifacts.runtimePlanPath;
      const runtimeStatePath = sessionRecord.artifacts.runtimeStatePath;
      const resultPath = sessionRecord.artifacts.resultPath;
      if (!runtimePlanPath || !runtimeStatePath || !resultPath) {
        throw new DevtaskError(`repo-plan session artifacts are incomplete for ${workId}/${repoId}`);
      }
      const graph = readWorkGraph(paths, workId);
      const graphTask = graph.tasks.find((t) => t.repoId === repoId);
      if (!graphTask) throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
      persistSharedRepoPlan(paths, workId, repoId, runtimePlanPath);
      const blocked = readTaskResult(resultPath).status === "blocked";
      removeIfExists(runtimePlanPath);
      removeIfExists(runtimeStatePath);
      removeIfExists(resultPath);
      const status = isFreshArtifactSince(planPath, sessionRecord.startedAt) ? (blocked ? "blocked" : "planned") : "failed";
      updateWorkItemStatus(paths, workId, status === "failed" ? "failed" : "planned");
      await updateRecentWork(paths, getWorkItem(paths, workId));
      return { status, artifacts: { planPath } };
    }
  },
  review: {
    resumeScope(paths, workId, repoId, _runId) {
      if (!repoId) throw new DevtaskError("review resume requires a repo id");
      const materialization = requireMaterialization(paths, workId);
      const task = materialization.tasks.find((t) => t.repoId === repoId);
      if (!task) throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
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
    },
    async freshScope(paths, workId, repoId, runId) {
      if (!repoId) throw new DevtaskError("review requires a repo id");
      const materialization = requireMaterialization(paths, workId);
      const task = materialization.tasks.find((entry) => entry.repoId === repoId);
      if (!task) throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
      const config = readConfig(paths);
      const storagePaths = taskStoragePaths(paths, task.repoPath);
      const meta = readTaskMeta(taskMetaPath(storagePaths, task.taskId));
      const clean = !(await hasUncommittedChanges(task.worktreePath));
      const commits = await countBranchCommits(task.worktreePath).catch(() => 0);
      const changedFiles = await readGitStatusShort(task.worktreePath);
      const diffStat = await readGitDiffStat(task.worktreePath);
      const reviewDir = workItemReviewDir(paths, workId);
      const promptPath = `${reviewDir}/${repoId}.prompt.md`;
      const outputPath = `${reviewDir}/${repoId}.output.md`;
      const reviewPath = `${reviewDir}/${repoId}.md`;
      const resultPath = `${reviewDir}/${repoId}.json`;
      const completionRunId = path.basename(promptPath).replace(/\.prompt\.md$/, "") || runId;
      return {
        scope: {
          tmuxSession: tmuxSessionName(resolvePaths(task.repoPath), `review-${workId}-${repoId}`),
          cwd: task.worktreePath,
          promptPath,
          outputPath,
          taskId: task.taskId,
          artifacts: { reviewPath, resultPath }
        },
        prompt: buildReviewPrompt(
          task, meta, reviewPath, resultPath,
          { clean, commits, changedFiles, diffStat, latestCheck: readWorkResultSummary(paths, workId, "check"), latestVerify: readWorkResultSummary(paths, workId, "verify"), latestCi: readWorkResultSummary(paths, workId, "ci") },
          collectPhaseMemory(paths, "review", { repoId })
        ),
        startOptions: {
          workspacePath: task.worktreePath,
          model: config.codex.model,
          fullAuto: false,
          skipGitRepoCheck: true,
          addDirs: [workItemDir(paths, workId)],
          managedCompletionCommand: buildManagedPhaseCompletionCommand(paths, "review", workId, repoId, completionRunId),
          env: { ...process.env, DEVTASK_TASK_DIR: workItemDir(paths, workId), DEVTASK_TASK_PATH: promptPath, DEVTASK_REVIEW_PATH: reviewPath, DEVTASK_REVIEW_RESULT_PATH: resultPath }
        }
      };
    },
    workspacePath(paths, workId, repoId) {
      if (!repoId) throw new DevtaskError("review requires a repo id");
      const materialization = requireMaterialization(paths, workId);
      const task = materialization.tasks.find((t) => t.repoId === repoId);
      if (!task) throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
      return task.worktreePath;
    },
    async finalize(_paths, workId, repoId, sessionRecord) {
      if (!repoId) throw new DevtaskError("review finalizer requires a repo id");
      const reviewPath = sessionRecord.artifacts.reviewPath;
      const resultPath = sessionRecord.artifacts.resultPath;
      if (!reviewPath || !resultPath) throw new DevtaskError(`review phase artifacts are incomplete for ${workId}/${repoId}`);
      const parsed = readReviewResult(resultPath);
      return { status: parsed?.status ?? "failed", artifacts: { reviewPath, resultPath } };
    }
  }
};

async function startInteractivePhaseWork(paths: DevtaskPaths, phase: InteractivePhase, workId: string, repoId: string | null): Promise<PhaseLaunchResult> {
  const runId = newRunId();
  const { scope, prompt, startOptions } = await PHASE_CONFIGS[phase].freshScope(paths, workId, repoId, runId);
  return startInteractivePhaseFreshSession(paths, phase, workId, repoId, { ...scope, prompt, startOptions });
}

export async function startSpecWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  return startInteractivePhaseWork(paths, "spec", workId, null);
}

export async function startPlanWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult> {
  return startInteractivePhaseWork(paths, "plan", workId, null);
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
  return startInteractivePhaseWork(paths, "repo-plan", workId, repoId);
}

export async function startReviewScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  return startInteractivePhaseWork(paths, "review", workId, repoId);
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

function isFreshArtifactSince(filePath: string, startedAt: string): boolean {
  const content = readTextIfExists(filePath).trim();
  if (!content) {
    return false;
  }
  try {
    return fs.statSync(filePath).mtimeMs >= Date.parse(startedAt);
  } catch {
    return false;
  }
}

function isFreshGraphSince(filePath: string, startedAt: string): boolean {
  if (!isFreshArtifactSince(filePath, startedAt)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: unknown; tasks?: unknown };
    return parsed.schemaVersion === 1 && Array.isArray(parsed.tasks);
  } catch {
    return false;
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
  const { status, artifacts } = await cfg.finalize(paths, workId, repoId, sessionRecord, session, finishedAt);
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
    writeExecutePhaseRun(workspacePaths, workId, task, meta, current.status);
    const existingRun = readRunningPhaseRun(phaseRunDir(workspacePaths, workId, "execute", task.repoId));
    if (existingRun) {
      updateRunningPhaseRun(phaseRunDir(workspacePaths, workId, "execute", task.repoId), {
        status: current.status === "blocked" ? "blocked" : current.status === "failed" ? "failed" : "completed",
        updatedAt: meta.updatedAt,
        session: {
          ...existingRun.session,
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
    writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
    recordExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, meta.tmuxSession!, {
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
  writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
  recordExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, sessionName, {
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

function persistExecutionMeta(metaPath: string, meta: TaskMeta): TaskMeta {
  writeTaskMeta(metaPath, meta);
  return meta;
}

function writeExecutePhaseRun(
  workspacePaths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number],
  meta: TaskMeta,
  status: string
): void {
  const provider = readConfig(workspacePaths).agent.provider;
  const runId = newRunId();
  writePhaseRunRecord(phaseRunDir(workspacePaths, workId, "execute", task.repoId), {
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
      resumeContext: {
        providerSessionId: meta.agentSessionId ?? null,
        conversationId: meta.agentThreadId ?? null,
        resumeTarget: meta.agentSessionId ?? null,
        storageRoot: null,
        transcriptPath: null
      },
      summary: meta.resultSummary,
      summaryIsFallback: true
    },
    artifacts: {
      taskPath: meta.taskPath,
      statePath: meta.statePath,
      resultPath: meta.resultPath
    },
    exitCode: null
  });
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildDevtaskCommand(args: string[]): string {
  const escaped = args.map((v) => shellEscape(v)).join(" ");
  const entry = shellEscape(path.resolve(process.cwd(), "dist/bin/devtask.js"));
  return `node ${entry} ${escaped}`;
}

function ensureNoLivePhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: string,
  repoId: string | null
): void {
  const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (run?.status === "running" && tmuxSessionExists(run.tmuxSession ?? "")) {
    const scope = repoId ? `${workId}/${repoId}` : workId;
    const attach = repoId ? `devtask work ${phase} attach ${workId} ${repoId}` : `devtask work ${phase} attach ${workId}`;
    const feedback = repoId
      ? `devtask work ${phase} feedback ${workId} ${repoId} "<message>"`
      : `devtask work ${phase} feedback ${workId} "<message>"`;
    throw new DevtaskError(`${phase} is already running for ${scope}. Use ${attach} or ${feedback}.`);
  }
}

function freshInteractiveExecuteSession(
  paths: DevtaskPaths,
  workId: string,
  repoId: string
): { taskId: string; repoPath: string; metaPath: string } {
  const materialization = readWorkMaterialization(paths, workId);
  const task = materialization?.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No repo task ${repoId} exists for work ${workId}`);
  }
  const storagePaths = taskStoragePaths(paths, task.repoPath);
  const metaPath = taskMetaPath(storagePaths, task.taskId);
  const meta = readTaskMeta(metaPath);
  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    throw new DevtaskError(`Execution is already running for ${workId}/${repoId}. Attach instead of starting fresh.`);
  }
  writeTaskMeta(metaPath, {
    ...meta,
    tmuxSession: null,
    status: "ready",
    resultSummary: null,
    runtime: null,
    updatedAt: new Date().toISOString()
  });
  return { taskId: task.taskId, repoPath: task.repoPath, metaPath };
}

function recordExecutePhaseSession(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  taskId: string,
  tmuxSession: string,
  meta: {
    promptPath: string;
    outputPath: string;
    resultPath: string;
    updatedAt: string;
    summary: string | null;
    provider: AgentSessionRef["provider"];
    providerSessionId: string | null;
    conversationId: string | null;
  }
): void {
  const dir = phaseRunDir(paths, workId, "execute", repoId);
  const current = readRunningPhaseRun(dir);
  const sessionRef: AgentSessionRef = {
    provider: meta.provider,
    transportId: tmuxSession,
    resumeContext: {
      providerSessionId: meta.providerSessionId,
      conversationId: meta.conversationId,
      resumeTarget: meta.providerSessionId,
      storageRoot: null,
      transcriptPath: null
    },
    summary: meta.summary,
    summaryIsFallback: true
  };
  const now = meta.updatedAt;
  const updated: PhaseRun = {
    ...(current ?? {
      schemaVersion: 1 as const,
      phase: "execute" as const,
      workId,
      repoId,
      runId: now,
      startedAt: now,
      finishedAt: null,
      exitCode: null
    }),
    taskId,
    tmuxSession,
    status: "running",
    updatedAt: now,
    promptPath: meta.promptPath,
    outputPath: meta.outputPath,
    artifacts: { taskPath: meta.promptPath, statePath: meta.outputPath, resultPath: meta.resultPath },
    session: sessionRef
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(updated, null, 2)}\n`);
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

function persistSharedRepoPlan(paths: DevtaskPaths, workId: string, repoId: string, sourcePlanPath: string): void {
  const plan = readTextIfExists(sourcePlanPath).trim();
  if (!plan) {
    return;
  }
  const target = workItemRepoPlanPath(paths, workId, repoId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${plan}\n`);
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
