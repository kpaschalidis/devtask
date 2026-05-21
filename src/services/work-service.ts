import fs from "node:fs";
import path from "node:path";
import type { DevtaskConfig } from "../infra/config.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resolvePaths,
  taskMetaPath,
  workItemDir,
  workItemRepoPlanPath,
  workItemResultsDir,
  workItemReviewDir,
  workItemSpecPath,
  workItemSpecRunsDir
} from "../infra/paths.js";
import { createDefaultAgentRunner, runAgentPrompt } from "../agent.js";
import { cleanupWorkItem, type WorkCleanupOptions, type WorkCleanupResult } from "../work-cleanup.js";
import { materializeWorkPlan, readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
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
  type WorkItem
} from "../storage/work-store.js";
import { fetchJiraIssue, writeJiraSourceArtifacts } from "../adapters/jira.js";
import { updateRecentWork } from "../storage/global-index.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { runCommand } from "../infra/process-runner.js";
import { buildReviewPrompt } from "../prompts/review.js";
import { buildSpecPrompt } from "../prompts/spec-plan.js";
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
  workId: string;
  status: "spec-ready" | "failed";
  specPath: string;
  promptPath: string;
  outputPath: string;
  exitCode: number | null;
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

export interface RepoPlanWorkResult {
  workId: string;
  repoPlans: RepoPlanTaskResult[];
  materialized: boolean;
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
  requireWorkSpec(paths, workId);
  const record = await runWorkPlanner(paths, item, config, options);
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
  } = {}
): Promise<WorkSpecResult> {
  const config: DevtaskConfig = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const result = await runSpecAgent(paths, item, config, options);
  writeWorkResult(paths, workId, "spec", result);
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

  const existingMaterialization = readWorkMaterialization(paths, workId);
  const materialization = existingMaterialization ?? (await materializeWorkPlan(paths, item));
  const repoPlans: RepoPlanTaskResult[] = [];

  for (const task of materialization.tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
    const latestPlan = readLatestPlan(repoPaths, task.taskId);

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

    const record = await runPlanAgent(repoPaths, meta, {
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
  await updateRecentWork(paths, item);
  return repoPlanResult;
}

export async function materializeWork(paths: DevtaskPaths, workId: string): Promise<WorkMaterialization> {
  const item = getWorkItem(paths, workId);
  const materialization = await materializeWorkPlan(paths, item);
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
  return result;
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
    const metaPath = taskMetaPath(repoPaths, task.taskId);
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
  return result;
}

export async function checkWorkCi(paths: DevtaskPaths, workId: string): Promise<CiWorkResult> {
  const workspaceConfig = readConfig(paths);
  const materialization = requireMaterialization(paths, workId);
  const tasks: CiTaskResult[] = [];

  for (const task of materialization.tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const metaPath = taskMetaPath(repoPaths, task.taskId);
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
  return result;
}

function requireMaterialization(paths: DevtaskPaths, workId: string): WorkMaterialization {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new Error(`Work ${workId} is not materialized. Run devtask work implement ${workId} first.`);
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
  }
): Promise<WorkSpecResult> {
  const specPath = workItemSpecPath(paths, item.id);
  const runsDir = workItemSpecRunsDir(paths, item.id);
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = Date.now().toString();
  const promptPath = `${runsDir}/${runId}.prompt.md`;
  const outputPath = `${runsDir}/${runId}.md`;
  const prompt = buildSpecPrompt(item, specPath);
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
  const command = runner.buildStartCommand?.(startOptions) ?? "agent-run";
  options.onStart?.({ command, promptPath, outputPath, specPath });
  const result = await runAgentPrompt(runner, startOptions, prompt, {
    outputPath,
    onOutput: (chunk) => {
      options.onStdout?.(chunk);
    }
  });
  const currentSpec = readTextIfExists(specPath).trim();
  const status: WorkSpecResult["status"] =
    result.status === "completed" && currentSpec.length > 0 ? "spec-ready" : "failed";
  return {
    workId: item.id,
    status,
    specPath,
    promptPath,
    outputPath,
    exitCode: result.status === "completed" ? 0 : null,
    generatedAt: new Date().toISOString()
  };
}

async function runReviewAgent(
  paths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number],
  config: DevtaskConfig,
  signals: { latestCheck: string | null; latestVerify: string | null; latestCi: string | null }
): Promise<ReviewTaskResult> {
  const repoPaths = resolvePaths(task.repoPath);
  const meta = readTaskMeta(taskMetaPath(repoPaths, task.taskId));
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
  const prompt = buildReviewPrompt(
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
    }
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
  const execResult = await runAgentPrompt(runner, startOptions, prompt, {
    outputPath
  });

  const parsed = readReviewResult(resultPath);
  const status: ReviewTaskResult["status"] =
    execResult.status !== "completed" ? "failed" : parsed?.status ?? "failed";
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

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
