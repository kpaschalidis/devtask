import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  taskStoragePaths,
  workItemDir,
  workItemLocalDir,
  workItemMaterializationPath,
  workItemRepoPlansDir,
  workItemResultsDir,
  workItemReviewDir,
  workItemSourcePath,
  workItemSpecPath
} from "../infra/paths.js";
import { listWorkPhaseRuns } from "./phase-run-service.js";
import { listWorkPhaseSessions } from "./phase-session-service.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { getTask } from "../storage/task-store.js";
import { getWorkItem } from "../storage/work-store.js";

export interface WorkInspection {
  workId: string;
  status: string;
  artifacts: Array<{ label: string; path: string; exists: boolean }>;
  latestPhaseRuns: Array<{
    phase: string;
    repoId: string | null;
    taskId: string | null;
    status: string;
    promptPath: string;
    outputPath: string;
    filePath: string;
    provider: string;
    transportId: string | null;
    conversationId: string | null;
    providerSessionId: string | null;
    resumeTarget: string | null;
    summary: string | null;
    storageRoot: string | null;
    transcriptPath: string | null;
    artifacts: Record<string, string>;
  }>;
  livePhaseSessions: Array<{
    phase: string;
    repoId: string | null;
    taskId: string | null;
    status: string;
    tmuxSession: string;
    live: boolean;
    promptPath: string;
    outputPath: string;
  }>;
  problemTasks: Array<{
    repoId: string;
    taskId: string;
    status: string;
    reason: string | null;
    worktreePath: string;
    sessionName: string | null;
  }>;
}

export function inspectWork(paths: DevtaskPaths, workId: string): WorkInspection {
  const item = getWorkItem(paths, workId);
  const materialization = readWorkMaterialization(paths, workId);
  const repoPlansDir = workItemRepoPlansDir(paths, workId);
  const artifacts = [
    artifact("source", workItemSourcePath(paths, workId)),
    artifact("spec", workItemSpecPath(paths, workId)),
    artifact("plan", path.join(workItemDir(paths, workId), "plan.md")),
    artifact("graph", path.join(workItemDir(paths, workId), "graph.json")),
    artifact("repo-plans", repoPlansDir),
    artifact("local-state", path.join(workItemLocalDir(paths, workId), "state.md")),
    artifact("materialization", workItemMaterializationPath(paths, workId)),
    artifact("results", workItemResultsDir(paths, workId)),
    artifact("reviews", workItemReviewDir(paths, workId)),
    artifact("phase-runs", path.join(workItemLocalDir(paths, workId), "phase-runs"))
  ];

  const latestPhaseRuns = listWorkPhaseRuns(paths, workId, { latest: true }).map((run) => ({
    phase: run.phase,
    repoId: run.repoId,
    taskId: run.taskId,
    status: run.status,
    promptPath: run.promptPath,
    outputPath: run.outputPath,
    filePath: run.filePath,
    provider: run.session.provider,
    transportId: run.session.transportId,
    conversationId: run.session.conversationId,
    providerSessionId: run.session.providerSessionId,
    resumeTarget: run.session.resumeTarget,
    summary: run.session.summary,
    storageRoot: run.session.storageRoot ?? null,
    transcriptPath: run.session.transcriptPath ?? null,
    artifacts: run.artifacts
  }));
  const livePhaseSessions = listWorkPhaseSessions(paths, workId)
    .filter((session) => session.live)
    .map((session) => ({
      phase: session.phase,
      repoId: session.repoId,
      taskId: session.taskId,
      status: session.status,
      tmuxSession: session.tmuxSession,
      live: session.live,
      promptPath: session.promptPath,
      outputPath: session.outputPath
    }));

  const problemTasks = (materialization?.tasks ?? [])
    .map((task) => {
      const storagePaths = taskStoragePaths(paths, task.repoPath);
      const meta = getTask(storagePaths, task.taskId);
      return {
        repoId: task.repoId,
        taskId: task.taskId,
        status: meta.status,
        reason: meta.runtime?.reason ?? meta.resultSummary,
        worktreePath: meta.worktreePath,
        sessionName: meta.tmuxSession
      };
    })
    .filter((task) => task.status === "blocked" || task.status === "failed" || task.status === "paused");

  return {
    workId,
    status: item.status,
    artifacts,
    latestPhaseRuns,
    livePhaseSessions,
    problemTasks
  };
}

function artifact(label: string, filePath: string): { label: string; path: string; exists: boolean } {
  return {
    label,
    path: filePath,
    exists: fs.existsSync(filePath)
  };
}
