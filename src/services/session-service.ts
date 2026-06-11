import type { DevtaskPaths } from "../infra/paths.js";
import { taskStoragePaths } from "../infra/paths.js";
import { DevtaskError } from "../infra/errors.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { attachTmuxSession, sendToTmuxSessionWithConfirmation, tmuxSessionExists } from "../infra/tmux.js";
import { getTask } from "../storage/task-store.js";

export interface SessionSummary {
  workId: string;
  repoId: string;
  taskId: string;
  taskStatus: "created" | "planned" | "ready" | "running" | "paused" | "blocked" | "done" | "failed";
  sessionName: string | null;
  worktreePath: string;
  sessionStatus: "active" | "inactive" | "none";
  runtimeState: "unknown" | "alive" | "missing" | "completed" | null;
  runtimeReason: string | null;
  lastActivityAt: string | null;
  resultSummary: string | null;
  threadId: string | null;
  agentSessionId: string | null;
  updatedAt: string;
}

export async function listSessions(paths: DevtaskPaths, workId?: string): Promise<SessionSummary[]> {
  const workIds = workId ? [workId] : [];
  if (!workId) {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const id of workIds) {
    const materialization = readWorkMaterialization(paths, id);
    if (!materialization) {
      continue;
    }
    for (const task of materialization.tasks) {
      const storagePaths = taskStoragePaths(paths, task.repoPath);
      const meta = getTask(storagePaths, task.taskId);
      summaries.push({
        workId: id,
        repoId: task.repoId,
        taskId: task.taskId,
        taskStatus: meta.status,
        sessionName: meta.tmuxSession,
        worktreePath: meta.worktreePath,
        sessionStatus: !meta.tmuxSession ? "none" : tmuxSessionExists(meta.tmuxSession) ? "active" : "inactive",
        runtimeState: meta.runtime?.state ?? null,
        runtimeReason: meta.runtime?.reason || meta.resultSummary,
        lastActivityAt: meta.runtime?.lastObservedAt ?? meta.updatedAt,
        resultSummary: meta.resultSummary,
        threadId: meta.agentThreadId,
        agentSessionId: meta.agentSessionId,
        updatedAt: meta.updatedAt
      });
    }
  }
  return summaries;
}

export async function getSession(paths: DevtaskPaths, workId: string, repoId: string): Promise<SessionSummary> {
  const sessions = await listSessions(paths, workId);
  const session = sessions.find((entry) => entry.repoId === repoId);
  if (!session) {
    throw new DevtaskError(`No repo task ${repoId} exists for work ${workId}`);
  }
  return session;
}

export async function attachSession(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const session = await getSession(paths, workId, repoId);
  if (!session.sessionName) {
    throw new DevtaskError(`No attachable session exists for ${workId}/${repoId}`);
  }
  attachTmuxSession(session.sessionName);
}

export async function sendSessionMessage(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  message: string
): Promise<{ confirmed: boolean; output: string }> {
  const session = await getSession(paths, workId, repoId);
  if (!session.sessionName) {
    throw new DevtaskError(`No attachable session exists for ${workId}/${repoId}`);
  }
  return sendToTmuxSessionWithConfirmation(session.sessionName, message, { lines: 40 });
}
