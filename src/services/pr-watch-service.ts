import { setTimeout as sleep } from "node:timers/promises";
import { readConfig } from "../infra/config.js";
import { workItemPrWatchStatePath } from "../infra/paths.js";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { sendToTmuxSession, tmuxSessionExists } from "../adapters/agent-kernel/tmux-control.js";
import { readPrWatchState, writePrWatchState } from "../storage/pr-watch-state.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { listProviderPullRequestComments, listProviderPullRequests, type PullRequestComment, type PullRequestSummary } from "../adapters/scm/index.js";
import { sendWorkPhaseFeedback } from "./work-service.js";

const PR_WATCH_PREFIX = "/devtask ";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface PrWatchRunResult {
  pickedUpCount: number;
}

interface PrWatchDependencies {
  listPullRequests: (worktreePath: string) => Promise<PullRequestSummary[]>;
  listPullRequestComments: (worktreePath: string, pullRequestId: string) => Promise<PullRequestComment[]>;
  sendToTmuxSession: (session: string, message: string) => void;
  sendFeedback: (paths: DevtaskPaths, workId: string, message: string) => Promise<unknown>;
  tmuxSessionExists: (session: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  readState: typeof readPrWatchState;
  writeState: typeof writePrWatchState;
  readNow: () => { tmuxSession: string | null; live: boolean };
}

const defaultDependencies = (paths: DevtaskPaths, workId: string): PrWatchDependencies => {
  const config = readConfig(paths);
  return {
    listPullRequests: (worktreePath) => listProviderPullRequests(worktreePath, config),
    listPullRequestComments: (worktreePath, pullRequestId) => listProviderPullRequestComments(worktreePath, pullRequestId, config),
    sendToTmuxSession,
    sendFeedback: (currentPaths, currentWorkId, message) => sendWorkPhaseFeedback(currentPaths, "orchestrate", currentWorkId, message),
    tmuxSessionExists,
    sleep: (ms) => sleep(ms),
    readState: readPrWatchState,
    writeState: writePrWatchState,
    readNow: () => {
      const run = readRunningPhaseRun(phaseRunDir(paths, workId, "orchestrate", null));
      const live = run?.status === "running" && !!run.tmuxSession && tmuxSessionExists(run.tmuxSession);
      return { tmuxSession: run?.tmuxSession ?? null, live };
    }
  };
};

export async function watchWorkPullRequests(
  paths: DevtaskPaths,
  workId: string,
  options: { intervalMs?: number; maxPolls?: number } = {},
  dependencies: Partial<PrWatchDependencies> = {}
): Promise<void> {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work item ${workId} has not been materialized. Run devtask work materialize ${workId} first.`);
  }

  const merged = { ...defaultDependencies(paths, workId), ...dependencies };
  const statePath = workItemPrWatchStatePath(paths, workId);
  const startupRun = merged.readNow();
  if (!startupRun.live) {
    console.warn(`Warning: no running orchestrator session found for ${workId}; continuing to poll for future feedback routing.`);
  }

  let polls = 0;
  while (true) {
    await runPrWatchIteration(paths, workId, statePath, materialization.tasks.map((task) => ({
      repoId: task.repoId,
      worktreePath: task.worktreePath
    })), merged);
    polls += 1;
    if (options.maxPolls !== undefined && polls >= options.maxPolls) {
      return;
    }
    await merged.sleep(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

export async function runPrWatchIteration(
  paths: DevtaskPaths,
  workId: string,
  statePath: string,
  scopes: Array<{ repoId: string; worktreePath: string }>,
  dependencies: Partial<PrWatchDependencies> = {}
): Promise<PrWatchRunResult> {
  const merged = { ...defaultDependencies(paths, workId), ...dependencies };
  const state = merged.readState(statePath);
  const processed = new Set(state.processedCommentIds);
  let dirty = false;
  let pickedUpCount = 0;

  for (const scope of scopes) {
    const pullRequests = await merged.listPullRequests(scope.worktreePath);
    const associated = pullRequests.filter((pullRequest) => matchesWorkItem(workId, pullRequest));
    for (const pullRequest of associated) {
      const comments = await merged.listPullRequestComments(scope.worktreePath, pullRequest.number);
      for (const comment of comments) {
        const instruction = extractDevTaskInstruction(comment.body);
        if (!instruction || processed.has(comment.id)) {
          continue;
        }
        const run = merged.readNow();
        if (run.live && run.tmuxSession) {
          merged.sendToTmuxSession(run.tmuxSession, instruction);
        } else {
          await merged.sendFeedback(paths, workId, instruction);
        }
        processed.add(comment.id);
        dirty = true;
        pickedUpCount += 1;
        console.log(`Picked up /devtask instruction from PR comment ${comment.id}`);
      }
    }
  }

  if (dirty) {
    merged.writeState(statePath, { processedCommentIds: [...processed] });
  }

  return { pickedUpCount };
}

export function extractDevTaskInstruction(body: string): string | null {
  const match = /^\/devtask\s+([\s\S]+)$/i.exec(body.trimStart());
  if (!match) {
    return null;
  }
  const instruction = match[1]?.trim();
  return instruction ? instruction : null;
}

function matchesWorkItem(workId: string, pullRequest: PullRequestSummary): boolean {
  const workIdNeedle = workId.toLowerCase();
  return (
    pullRequest.branch.toLowerCase().includes(workIdNeedle) ||
    pullRequest.title.toLowerCase().includes(workIdNeedle)
  );
}

export { DEFAULT_POLL_INTERVAL_MS, PR_WATCH_PREFIX };
