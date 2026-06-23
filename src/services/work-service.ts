import fs from "node:fs";
import path from "node:path";
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
  workItemLearningsPath,
  workItemValidationContractPath,
  phaseRunDir,
  resultJsonPath
} from "../infra/paths.js";
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
import { killTmuxSession, tmuxSessionExists } from "../adapters/agent-kernel/tmux-control.js";
import { DevtaskError } from "../infra/errors.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { loadInstruction } from "../instructions/loader.js";
import { buildCompoundPrompt } from "../prompts/compound.js";
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
import { runWorkAgentPrompt } from "./agent-prompt-service.js";
export { runRepoPlanWorker } from "./repo-plan-work-service.js";
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

export type { ExecuteTaskResult, ExecuteWorkResult };

export interface CompoundWorkResult {
  workId: string;
  status: "completed" | "failed";
  promptPath: string;
  outputPath: string;
  learningsPath: string;
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


export async function compoundWork(paths: DevtaskPaths, workId: string): Promise<CompoundWorkResult> {
  const config = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const runsDir = phaseRunDir(paths, workId, "compound", null);
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = newRunId();
  const promptPath = path.join(runsDir, `${runId}.prompt.md`);
  const outputPath = path.join(runsDir, `${runId}.md`);
  const learningsPath = workItemLearningsPath(paths, workId);
  const specFile = path.join(paths.workDir, workId, "spec.md");
  const specPath = fs.existsSync(specFile) ? specFile : null;
  const contractFile = workItemValidationContractPath(paths, workId);
  const contractPath = fs.existsSync(contractFile) ? contractFile : null;
  const planPath = fs.existsSync(path.join(paths.workDir, workId, "plan.md")) ? path.join(paths.workDir, workId, "plan.md") : null;
  const graphPath = fs.existsSync(path.join(paths.workDir, workId, "graph.json")) ? path.join(paths.workDir, workId, "graph.json") : null;
  const prompt = buildCompoundPrompt({
    workId,
    sourcePath: item.source.artifact,
    specPath,
    contractPath,
    planPath,
    graphPath,
    repoPlansDir: workItemRepoPlansDir(paths, workId),
    resultsDir: workItemResultsDir(paths, workId),
    reviewsDir: workItemReviewDir(paths, workId),
    learningsPath
  });
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const startedAt = new Date().toISOString();
  const result = await runWorkAgentPrompt(
    config,
    {
      workspacePath: paths.root,
      model: config.codex.model,
      fullAuto: config.codex.fullAuto,
      skipGitRepoCheck: true,
      addDirs: [workItemDir(paths, workId)],
      env: {
        ...process.env,
        DEVTASK_TASK_DIR: workItemDir(paths, workId),
        DEVTASK_TASK_PATH: promptPath
      }
    },
    prompt,
    { outputPath }
  );
  const finishedAt = new Date().toISOString();
  const status: CompoundWorkResult["status"] =
    result.status === "completed" && isFreshNonEmptyFile(learningsPath, startedAt) ? "completed" : "failed";
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
      learningsPath
    },
    exitCode: status === "completed" ? 0 : null
  });
  const compoundResult: CompoundWorkResult = {
    workId,
    status,
    promptPath,
    outputPath,
    learningsPath,
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

  const result = await runWorkAgentPrompt(
    config,
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

function isFreshNonEmptyFile(filePath: string, startedAt: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf8").trim().length > 0 &&
      fs.statSync(filePath).mtimeMs >= Date.parse(startedAt);
  } catch {
    return false;
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
