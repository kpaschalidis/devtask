import fs from "node:fs";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  resolvePaths,
  workItemDir,
  workItemReviewDir,
  workItemValidationContractPath
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { loadInstruction } from "../instructions/loader.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { DevtaskError } from "../infra/errors.js";
import {
  launchPhaseFresh,
  launchPhaseResume,
  readPreviousSession,
  buildFeedbackPrompt,
  killLiveSession,
  attachTmuxSession
} from "./runner.js";
import type { RoleConfig, RoleFreshScope, RoleScope } from "./types.js";

export const reviewPhase: RoleConfig = {
  resumeScope(paths, workId, repoId, _runId): RoleScope {
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

  async freshScope(paths, workId, repoId, _runId): Promise<RoleFreshScope> {
    if (!repoId) throw new DevtaskError("review requires a repo id");
    const materialization = requireMaterialization(paths, workId);
    const task = materialization.tasks.find((t) => t.repoId === repoId);
    if (!task) throw new DevtaskError(`No review task exists for ${workId}/${repoId}`);
    const config = readConfig(paths);
    const reviewDir = workItemReviewDir(paths, workId);
    const promptPath = `${reviewDir}/${repoId}.prompt.md`;
    const outputPath = `${reviewDir}/${repoId}.output.md`;
    const reviewPath = `${reviewDir}/${repoId}.md`;
    const resultPath = `${reviewDir}/${repoId}.json`;
    const contractPath = workItemValidationContractPath(paths, workId);
    return {
      scope: {
        tmuxSession: tmuxSessionName(resolvePaths(task.repoPath), `review-${workId}-${repoId}`),
        cwd: task.worktreePath,
        promptPath,
        outputPath,
        taskId: task.taskId,
        artifacts: { reviewPath, resultPath }
      },
      prompt: loadInstruction("validator", {
        WORK_ID: workId,
        TASK_ID: task.taskId,
        REPO_ID: task.repoId,
        WORKTREE_PATH: task.worktreePath,
        CONTRACT_PATH: contractPath,
        RESULT_PATH: resultPath
      }),
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
          DEVTASK_REVIEW_RESULT_PATH: resultPath,
          DEVTASK_VALIDATION_CONTRACT_PATH: contractPath
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
    const rawStatus = parsed?.status ?? "failed";
    const status = rawStatus === "approved" || rawStatus === "passed" ? "approved" : "failed";
    return { status, artifacts: { reviewPath, resultPath } };
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

export type AssertionAttribution = "spec-gap" | "implementation-gap" | "environment" | "wrong-repo" | "inconclusive" | null;

export interface AssertionResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  evidence: string;
  attribution: AssertionAttribution;
  attributionReason: string | null;
}

export interface ReviewResult {
  status: "approved" | "passed" | "findings" | "blocked" | "failed";
  assertions: AssertionResult[];
}

function readReviewResult(filePath: string): ReviewResult | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { status?: unknown; assertions?: unknown };
    const status = value.status;
    if (
      status === "approved" ||
      status === "passed" ||
      status === "failed" ||
      status === "findings" ||
      status === "blocked"
    ) {
      return { status, assertions: parseAssertions(value.assertions) };
    }
  } catch {
    // ignore malformed
  }
  return null;
}

export function readReviewResultFromPath(filePath: string): ReviewResult | null {
  return readReviewResult(filePath);
}

function parseAssertions(raw: unknown): AssertionResult[] {
  if (!Array.isArray(raw)) return [];
  const results: AssertionResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const status = obj.status === "passed" || obj.status === "failed" || obj.status === "skipped" ? obj.status : null;
    if (!id || !status) continue;
    const attribution = parseAttribution(obj.attribution);
    results.push({
      id,
      status,
      evidence: typeof obj.evidence === "string" ? obj.evidence : "",
      attribution,
      attributionReason: typeof obj.attributionReason === "string" ? obj.attributionReason : null
    });
  }
  return results;
}

function parseAttribution(value: unknown): AssertionAttribution {
  if (value === null || value === undefined) return null;
  if (
    value === "spec-gap" ||
    value === "implementation-gap" ||
    value === "environment" ||
    value === "wrong-repo" ||
    value === "inconclusive"
  ) {
    return value;
  }
  return null;
}
