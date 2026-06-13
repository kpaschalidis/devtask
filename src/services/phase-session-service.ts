import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { DevtaskError } from "../infra/errors.js";
import { readRunningPhaseRun, updateRunningPhaseRun, writeRunningPhaseRun, type PhaseRun } from "../infra/phase-run.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { GLOBAL_PHASES, phaseRunDir, taskStoragePaths, taskMetaPath } from "../infra/paths.js";
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
  status: string;
  live: boolean;
  startedAt: string;
  updatedAt: string;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: AgentSessionRef;
}

function toSummary(run: PhaseRun): PhaseSessionSummary {
  return {
    phase: run.phase as ManagedPhase,
    workId: run.workId,
    repoId: run.repoId,
    taskId: run.taskId,
    runId: run.runId,
    tmuxSession: run.tmuxSession ?? "",
    status: run.status,
    live: run.status === "running" && tmuxSessionExists(run.tmuxSession ?? ""),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    promptPath: run.promptPath,
    outputPath: run.outputPath,
    artifacts: run.artifacts,
    session: run.session
  };
}

export function listWorkPhaseSessions(paths: DevtaskPaths, workId: string): PhaseSessionSummary[] {
  const base = path.join(paths.localDir, "work", workId, "phases");
  if (!pathExists(base)) {
    return [];
  }

  const entries: PhaseSessionSummary[] = [];
  for (const phase of ["spec", "plan", "repo-plan", "review", "execute"] as const) {
    const phaseDir = path.join(base, phase);
    if (!pathExists(phaseDir)) {
      continue;
    }
    if (GLOBAL_PHASES.has(phase)) {
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
  const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId ?? null));
  if (!run) {
    return null;
  }
  return toSummary(run);
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
  input: Omit<PhaseRun, "schemaVersion" | "status" | "updatedAt" | "finishedAt" | "exitCode"> & { tmuxSession: string }
): PhaseSessionSummary {
  const dir = phaseRunDir(paths, input.workId, input.phase, input.repoId);
  writeRunningPhaseRun(dir, input);
  return toSummary({
    schemaVersion: 1,
    status: "running",
    updatedAt: input.startedAt,
    finishedAt: null,
    exitCode: null,
    ...input
  });
}

export function updateScopedPhaseSession(
  paths: DevtaskPaths,
  workId: string,
  phase: ManagedPhase,
  repoId: string | null,
  update: Partial<Pick<PhaseRun, "status" | "updatedAt" | "promptPath" | "outputPath" | "artifacts" | "session" | "taskId" | "runId">>
): PhaseSessionSummary | null {
  const dir = phaseRunDir(paths, workId, phase, repoId);
  const next = updateRunningPhaseRun(dir, update);
  if (!next) {
    return null;
  }
  return toSummary(next);
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
  meta: {
    promptPath: string;
    outputPath: string;
    resultPath: string;
    updatedAt: string;
    summary: string | null;
    provider: AgentSessionRef["provider"];
    providerSessionId: string | null;
    conversationId: string | null;
  }
): void {
  const dir = phaseRunDir(paths, workId, "execute", repoId);
  const current = readRunningPhaseRun(dir);
  const sessionRef: AgentSessionRef = {
    provider: meta.provider,
    transportId: tmuxSession,
    resumeContext: {
      providerSessionId: meta.providerSessionId,
      conversationId: meta.conversationId,
      resumeTarget: meta.providerSessionId,
      storageRoot: null,
      transcriptPath: null
    },
    summary: meta.summary,
    summaryIsFallback: true
  };
  const now = meta.updatedAt;
  const artifacts = {
    taskPath: meta.promptPath,
    statePath: meta.outputPath,
    resultPath: meta.resultPath
  };
  const updated: PhaseRun = {
    ...(current ?? {
      schemaVersion: 1 as const,
      phase: "execute" as const,
      workId,
      repoId,
      runId: now,
      startedAt: now,
      finishedAt: null,
      exitCode: null
    }),
    taskId,
    tmuxSession,
    status: "running",
    updatedAt: now,
    promptPath: meta.promptPath,
    outputPath: meta.outputPath,
    artifacts,
    session: sessionRef
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(updated, null, 2)}\n`);
}

export function clearExecutePhaseSessionIfInactive(paths: DevtaskPaths, workId: string, repoId: string): void {
  const dir = phaseRunDir(paths, workId, "execute", repoId);
  const current = readRunningPhaseRun(dir);
  if (!current) {
    return;
  }
  if (!tmuxSessionExists(current.tmuxSession ?? "")) {
    updateRunningPhaseRun(dir, {
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
  const feedback = repoId
    ? `devtask work ${phase} feedback ${workId} ${repoId} "<message>"`
    : `devtask work ${phase} feedback ${workId} "<message>"`;
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
