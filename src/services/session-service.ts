import type { AgentSessionRef } from "../agent-session.js";
import { createDefaultAgentRunner } from "../agent.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { taskStoragePaths } from "../infra/paths.js";
import { DevtaskError } from "../infra/errors.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { attachTmuxSession, sendToTmuxSessionWithConfirmation, tmuxSessionExists } from "../infra/tmux.js";
import { listWorkAgentSessions } from "./agent-session-registry-service.js";
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
  provider: "codex" | "cursor" | null;
  conversationId: string | null;
  providerSessionId: string | null;
  resumeTarget: string | null;
  storageRoot: string | null;
  transcriptPath: string | null;
  updatedAt: string;
}

export async function listSessions(paths: DevtaskPaths, workId?: string): Promise<SessionSummary[]> {
  const workIds = workId ? [workId] : [];
  if (!workId) {
    return [];
  }
  const summaries: SessionSummary[] = [];
  const registryEntriesByScope = new Map(
    listWorkAgentSessions(paths, workId, { latest: true }).map((entry) => [`${entry.repoId ?? "-"}:${entry.taskId ?? "-"}`, entry] as const)
  );
  for (const id of workIds) {
    const materialization = readWorkMaterialization(paths, id);
    if (!materialization) {
      continue;
    }
    for (const task of materialization.tasks) {
      const storagePaths = taskStoragePaths(paths, task.repoPath);
      const meta = getTask(storagePaths, task.taskId);
      const registryEntry = registryEntriesByScope.get(`${task.repoId}:${task.taskId}`);
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
        lastActivityAt: registryEntry?.finishedAt ?? meta.runtime?.lastObservedAt ?? meta.updatedAt,
        resultSummary: registryEntry?.session.summary ?? meta.resultSummary,
        provider: registryEntry?.session.provider ?? null,
        conversationId: registryEntry?.session.conversationId ?? meta.agentThreadId,
        providerSessionId: registryEntry?.session.providerSessionId ?? meta.agentSessionId,
        resumeTarget: registryEntry?.session.resumeTarget ?? meta.agentSessionId,
        storageRoot: registryEntry?.session.storageRoot ?? null,
        transcriptPath: registryEntry?.session.transcriptPath ?? null,
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

export function buildSessionResumeCommand(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  prompt?: string | null
): string {
  const config = readConfig(paths);
  const runner = createDefaultAgentRunner(config);
  const materialization = readWorkMaterialization(paths, workId);
  const task = materialization?.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No repo task ${repoId} exists for work ${workId}`);
  }

  const session = sessionSummaryToRef(getSessionSync(paths, workId, repoId));
  if (!session.resumeTarget && !session.providerSessionId && !session.conversationId) {
    throw new DevtaskError(`No resumable agent session exists for ${workId}/${repoId}`);
  }

  const command = runner.buildResumeCommand?.(session, {
    workspacePath: task.repoPath,
    model: config.codex.model,
    prompt: prompt?.trim() ? prompt.trim() : null
  });
  if (!command) {
    throw new DevtaskError(`Provider ${session.provider} does not support resumable sessions yet`);
  }
  return command;
}

function getSessionSync(paths: DevtaskPaths, workId: string, repoId: string): SessionSummary {
  const registryEntriesByScope = new Map(
    listWorkAgentSessions(paths, workId, { latest: true }).map((entry) => [`${entry.repoId ?? "-"}:${entry.taskId ?? "-"}`, entry] as const)
  );
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`No repo task ${repoId} exists for work ${workId}`);
  }

  const task = materialization.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No repo task ${repoId} exists for work ${workId}`);
  }

  const storagePaths = taskStoragePaths(paths, task.repoPath);
  const meta = getTask(storagePaths, task.taskId);
  const registryEntry = registryEntriesByScope.get(`${task.repoId}:${task.taskId}`);
  return {
    workId,
    repoId: task.repoId,
    taskId: task.taskId,
    taskStatus: meta.status,
    sessionName: meta.tmuxSession,
    worktreePath: meta.worktreePath,
    sessionStatus: !meta.tmuxSession ? "none" : tmuxSessionExists(meta.tmuxSession) ? "active" : "inactive",
    runtimeState: meta.runtime?.state ?? null,
    runtimeReason: meta.runtime?.reason || meta.resultSummary,
    lastActivityAt: registryEntry?.finishedAt ?? meta.runtime?.lastObservedAt ?? meta.updatedAt,
    resultSummary: registryEntry?.session.summary ?? meta.resultSummary,
    provider: registryEntry?.session.provider ?? null,
    conversationId: registryEntry?.session.conversationId ?? meta.agentThreadId,
    providerSessionId: registryEntry?.session.providerSessionId ?? meta.agentSessionId,
    resumeTarget: registryEntry?.session.resumeTarget ?? meta.agentSessionId,
    storageRoot: registryEntry?.session.storageRoot ?? null,
    transcriptPath: registryEntry?.session.transcriptPath ?? null,
    updatedAt: meta.updatedAt
  };
}

function sessionSummaryToRef(session: SessionSummary): AgentSessionRef {
  return {
    provider: session.provider ?? "codex",
    transportId: session.sessionName,
    providerSessionId: session.providerSessionId,
    conversationId: session.conversationId,
    resumeTarget: session.resumeTarget,
    storageRoot: session.storageRoot,
    transcriptPath: session.transcriptPath,
    summary: session.resultSummary,
    summaryIsFallback: null
  };
}
