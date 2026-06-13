import fs from "node:fs";
import path from "node:path";
import { emptyAgentSessionRef, type AgentSessionRef } from "../agent-session.js";
import { DevtaskError } from "../infra/errors.js";
import { readPhaseSessionRecord, type PhaseSessionRecord, writePhaseSessionRecord } from "../infra/phase-session.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { taskStoragePaths, taskMetaPath, workItemScopedPhaseSessionDir } from "../infra/paths.js";
import { attachTmuxSession, sendToTmuxSessionWithConfirmation, tmuxSessionExists } from "../infra/tmux.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import { readWorkMaterialization } from "../work-materializer.js";

type ManagedPhase = "spec" | "plan" | "repo-plan" | "review" | "execute";

export interface PhaseSessionSummary {
  phase: ManagedPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  runId: string;
  tmuxSession: string;
  status: "running" | "completed" | "failed" | "blocked";
  live: boolean;
  startedAt: string;
  updatedAt: string;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: AgentSessionRef;
}

export function listWorkPhaseSessions(paths: DevtaskPaths, workId: string): PhaseSessionSummary[] {
  const base = path.join(paths.localDir, "work", workId, "phase-sessions");
  if (!pathExists(base)) {
    return [];
  }

  const entries: PhaseSessionSummary[] = [];
  for (const phase of ["spec", "plan", "repo-plan", "review", "execute"] as const) {
    const phaseDir = path.join(base, phase);
    if (!pathExists(phaseDir)) {
      continue;
    }
    if (phase === "spec" || phase === "plan") {
      const session = readScopedPhaseSession(paths, workId, phase);
      if (session) {
        entries.push(session);
      }
      continue;
    }
    for (const repoDir of fs.readdirSync(phaseDir)) {
      const session = readScopedPhaseSession(paths, workId, phase, repoDir);
      if (session) {
        entries.push(session);
      }
    }
  }

  return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId?: string | null
): PhaseSessionSummary | null {
  const record = readPhaseSessionRecord(workItemScopedPhaseSessionDir(paths, workId, phase, repoId ?? null));
  if (!record) {
    return null;
  }
  return {
    ...record,
    live: record.status === "running" && tmuxSessionExists(record.tmuxSession)
  };
}

export function ensureNoLiveScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId?: string | null
): void {
  const current = readScopedPhaseSession(paths, workId, phase, repoId ?? null);
  if (current?.live) {
    throw new DevtaskError(buildAlreadyRunningMessage(phase, workId, repoId ?? null));
  }
}

export function writeRunningScopedPhaseSession(
  paths: DevtaskPaths,
  input: Omit<PhaseSessionRecord, "schemaVersion" | "status" | "updatedAt">
): PhaseSessionSummary {
  const record: PhaseSessionRecord = {
    ...input,
    schemaVersion: 1,
    status: "running",
    updatedAt: input.startedAt
  };
  writePhaseSessionRecord(workItemScopedPhaseSessionDir(paths, input.workId, input.phase, input.repoId), record);
  return {
    ...record,
    live: true
  };
}

export function updateScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId: string | null,
  update: Partial<Pick<PhaseSessionRecord, "status" | "updatedAt" | "promptPath" | "outputPath" | "artifacts" | "session" | "taskId" | "runId">>
): PhaseSessionSummary | null {
  const current = readPhaseSessionRecord(workItemScopedPhaseSessionDir(paths, workId, phase, repoId));
  if (!current) {
    return null;
  }
  const next: PhaseSessionRecord = {
    ...current,
    ...update,
    session: update.session ?? current.session,
    artifacts: update.artifacts ?? current.artifacts
  };
  writePhaseSessionRecord(workItemScopedPhaseSessionDir(paths, workId, phase, repoId), next);
  return {
    ...next,
    live: next.status === "running" && tmuxSessionExists(next.tmuxSession)
  };
}

export function attachScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId?: string | null
): void {
  const session = requireScopedPhaseSession(paths, workId, phase, repoId ?? null);
  attachTmuxSession(session.tmuxSession);
}

export function sendScopedPhaseFeedback(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  message: string,
  repoId?: string | null
): { confirmed: boolean; output: string } {
  const session = requireScopedPhaseSession(paths, workId, phase, repoId ?? null);
  return sendToTmuxSessionWithConfirmation(session.tmuxSession, message, { lines: 60 });
}

export function markExecutePhaseSession(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  taskId: string,
  tmuxSession: string,
  meta: { promptPath: string; outputPath: string; resultPath: string; updatedAt: string; summary: string | null; provider: AgentSessionRef["provider"]; providerSessionId: string | null; conversationId: string | null }
): void {
  const dir = workItemScopedPhaseSessionDir(paths, workId, "execute", repoId);
  const current = readPhaseSessionRecord(dir);
  const sessionRef: AgentSessionRef = {
    provider: meta.provider,
    transportId: tmuxSession,
    providerSessionId: meta.providerSessionId,
    conversationId: meta.conversationId,
    resumeTarget: meta.providerSessionId,
    storageRoot: null,
    transcriptPath: null,
    summary: meta.summary,
    summaryIsFallback: true
  };

  const record: PhaseSessionRecord = current ?? {
    schemaVersion: 1,
    phase: "execute",
    workId,
    repoId,
    taskId,
    runId: meta.updatedAt,
    tmuxSession,
    status: "running",
    startedAt: meta.updatedAt,
    updatedAt: meta.updatedAt,
    promptPath: meta.promptPath,
    outputPath: meta.outputPath,
    artifacts: {
      taskPath: meta.promptPath,
      statePath: meta.outputPath,
      resultPath: meta.resultPath
    },
    session: sessionRef
  };

  writePhaseSessionRecord(dir, {
    ...record,
    taskId,
    tmuxSession,
    updatedAt: meta.updatedAt,
    promptPath: meta.promptPath,
    outputPath: meta.outputPath,
    artifacts: {
      taskPath: meta.promptPath,
      statePath: meta.outputPath,
      resultPath: meta.resultPath
    },
    session: sessionRef,
    status: "running"
  });
}

export function clearExecutePhaseSessionIfInactive(paths: DevtaskPaths, workId: string, repoId: string): void {
  const current = readPhaseSessionRecord(workItemScopedPhaseSessionDir(paths, workId, "execute", repoId));
  if (!current) {
    return;
  }
  if (!tmuxSessionExists(current.tmuxSession)) {
    writePhaseSessionRecord(workItemScopedPhaseSessionDir(paths, workId, "execute", repoId), {
      ...current,
      status: current.status === "running" ? "failed" : current.status,
      updatedAt: new Date().toISOString()
    });
  }
}

export function freshExecuteSession(
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
  return {
    taskId: task.taskId,
    repoPath: task.repoPath,
    metaPath
  };
}

function requireScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId: string | null
): PhaseSessionSummary {
  const session = readScopedPhaseSession(paths, workId, phase, repoId);
  if (!session) {
    throw new DevtaskError(`No ${phase} session exists for ${formatScope(workId, repoId)}`);
  }
  if (!session.live) {
    throw new DevtaskError(`The latest ${phase} session for ${formatScope(workId, repoId)} is not running`);
  }
  return session;
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function formatScope(workId: string, repoId: string | null): string {
  return repoId ? `${workId}/${repoId}` : workId;
}

function buildAlreadyRunningMessage(phase: ManagedPhase, workId: string, repoId: string | null): string {
  const attach = repoId ? `devtask work ${phase} attach ${workId} ${repoId}` : `devtask work ${phase} attach ${workId}`;
  const feedback = repoId ? `devtask work ${phase} feedback ${workId} ${repoId} "<message>"` : `devtask work ${phase} feedback ${workId} "<message>"`;
  return `${phase} is already running for ${formatScope(workId, repoId)}. Use ${attach} or ${feedback}.`;
}



export function phaseWorkerCommand(args: string[]): string {
  const escaped = args.map((value) => shellEscape(value)).join(" ");
  const entry = shellEscape(path.resolve(process.cwd(), "dist/bin/devtask.js"));
  return `node ${entry} ${escaped}`;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
