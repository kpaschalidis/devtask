import fs from "node:fs";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  resolvePaths,
  taskMetaPath,
  taskStoragePaths,
  workItemDir,
  workItemResultsDir,
  workItemReviewDir
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/phase-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { buildReviewPrompt } from "../prompts/review.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { readTaskMeta } from "../storage/meta.js";
import { runCommand } from "../infra/process-runner.js";
import { hasUncommittedChanges, countBranchCommits } from "../adapters/scm/index.js";
import { DevtaskError } from "../infra/errors.js";
import {
  launchPhaseFresh,
  launchPhaseResume,
  readPreviousSession,
  buildFeedbackPrompt,
  killLiveSession,
  attachTmuxSession
} from "./runner.js";
import type { PhaseConfig, PhaseFreshScope, PhaseScope } from "./types.js";

export const reviewPhase: PhaseConfig = {
  resumeScope(paths, workId, repoId, _runId): PhaseScope {
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

  async freshScope(paths, workId, repoId, runId): Promise<PhaseFreshScope> {
    if (!repoId) throw new DevtaskError("review requires a repo id");
    const materialization = requireMaterialization(paths, workId);
    const task = materialization.tasks.find((t) => t.repoId === repoId);
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
        {
          clean,
          commits,
          changedFiles,
          diffStat,
          latestCheck: readWorkResultSummary(paths, workId, "check"),
          latestVerify: readWorkResultSummary(paths, workId, "verify"),
          latestCi: readWorkResultSummary(paths, workId, "ci")
        },
        collectPhaseMemory(paths, "review", { repoId })
      ),
      startOptions: {
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
    if (!reviewPath || !resultPath) {
      throw new DevtaskError(`review phase artifacts are incomplete for ${workId}/${repoId}`);
    }
    const parsed = readReviewResult(resultPath);
    return { status: parsed?.status ?? "failed", artifacts: { reviewPath, resultPath } };
  },

  async attach(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("review attach requires a repo id");
    const dir = phaseRunDir(paths, workId, "review", repoId);
    const current = readRunningPhaseRun(dir);
    if (current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "")) {
      attachTmuxSession(current.tmuxSession!);
      return;
    }
    const launched = await launchPhaseResume(reviewPhase, paths, workId, "review", repoId);
    attachTmuxSession(launched.tmuxSession);
  },

  async sendFeedback(paths, workId, repoId, message) {
    if (!repoId) throw new DevtaskError("review feedback requires a repo id");
    const previous = readPreviousSession(paths, workId, "review", repoId);
    const prompt = buildFeedbackPrompt("review", message, previous.session);
    return launchPhaseResume(reviewPhase, paths, workId, "review", repoId, prompt, true);
  },

  reset(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("review reset requires a repo id");
    killLiveSession(paths, workId, "review", repoId);
    updateRunningPhaseRun(phaseRunDir(paths, workId, "review", repoId), {
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
  }
};

function requireMaterialization(paths: DevtaskPaths, workId: string) {
  const m = readWorkMaterialization(paths, workId);
  if (!m) throw new Error(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  return m;
}

function readReviewResult(filePath: string): { status: "approved" | "findings" | "blocked"; summary: string; findings: string[] } | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { status?: unknown; summary?: unknown; findings?: unknown };
    if ((value.status === "approved" || value.status === "findings" || value.status === "blocked") && typeof value.summary === "string") {
      return {
        status: value.status,
        summary: value.summary,
        findings: Array.isArray(value.findings)
          ? value.findings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : []
      };
    }
  } catch {
    // ignore malformed
  }
  return null;
}

function readWorkResultSummary(paths: DevtaskPaths, workId: string, name: string): string | null {
  try {
    const resultsDir = workItemResultsDir(paths, workId);
    const value = JSON.parse(fs.readFileSync(`${resultsDir}/${name}.json`, "utf8")) as { tasks?: Array<{ status?: unknown }> };
    if (!Array.isArray(value.tasks) || value.tasks.length === 0) return null;
    const statuses = value.tasks.map((t) => (typeof t.status === "string" ? t.status : null)).filter(Boolean) as string[];
    return statuses.length > 0 ? statuses.join(",") : null;
  } catch {
    return null;
  }
}

async function readGitStatusShort(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
  return result.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

async function readGitDiffStat(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["diff", "--stat"], { cwd: worktreePath });
  return result.stdout.trim();
}
