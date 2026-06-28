import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  resultJsonPath,
  taskMetaPath,
  taskStoragePaths,
  workItemCiWatchDir,
  workItemDir,
} from "../infra/paths.js";
import { writePhaseRunRecord } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import { DevtaskError } from "../infra/errors.js";
import { runCommandOrThrow } from "../infra/process-runner.js";
import {
  checkProviderCi,
  hasUncommittedChanges,
  pushBranchUpdate,
} from "../adapters/scm/index.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { getWorkItem, updateWorkItemStatus } from "../storage/work-store.js";
import { updateRecentWork } from "../storage/global-index.js";
import { readWorkMaterialization } from "./work-materialization-service.js";
import { runWorkAgentPrompt } from "./agent-prompt-service.js";
import { runDeterministicChecksForRepo } from "./deterministic-check-service.js";
import { writeScopedVerifyResult, writeWorkResult } from "./work-result-service.js";
import type {
  CiFixAttemptResult,
  CiTaskResult,
  CiWatchTaskResult,
  CiWatchWorkResult,
  CiWorkResult,
} from "./work-service.js";

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

export function resetTaskForFix(paths: DevtaskPaths, workId: string, repoId: string): void {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work item "${workId}" has not been materialized.`);
  }
  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No materialized task found for repo "${repoId}" in work item "${workId}".`);
  }
  removeIfExists(resultJsonPath(paths, task.taskId));
}

function requireMaterialization(paths: DevtaskPaths, workId: string) {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  }
  return materialization;
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
