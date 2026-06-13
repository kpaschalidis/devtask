import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  resolvePaths,
  taskMetaPath,
  taskStoragePaths,
  workItemResultsDir
} from "../infra/paths.js";
import { writePhaseRunRecord, readRunningPhaseRun, updateRunningPhaseRun, type PhaseRun } from "../infra/phase-run.js";
import { newRunId } from "../infra/run-record.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { readWorkMaterialization, type WorkMaterialization } from "../work-materializer.js";
import { getWorkItem } from "../storage/work-item.js";
import { readTaskMeta, writeTaskMeta } from "../storage/meta.js";
import {
  createBareSession,
  sendLaunchCommand,
  sendToTmuxSessionWithConfirmation,
  tmuxSessionExists,
  tmuxSessionName,
  waitForTmuxSession,
  writeLaunchScript
} from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import type { TaskMeta } from "../types.js";
import type { PhaseConfig, PhaseFreshScope, PhaseResult, PhaseScope } from "./types.js";

export interface ExecuteTaskResult {
  repoId: string;
  taskId: string;
  status: "running" | "paused" | "blocked" | "done" | "failed";
  action: "started" | "reattached" | "resumed" | "skipped";
  sessionName: string | null;
  summary: string | null;
  worktreePath: string;
}

export interface ExecuteWorkResult {
  workId: string;
  tasks: ExecuteTaskResult[];
  generatedAt: string;
}

export const executePhase: PhaseConfig = {
  freshScope(_paths, _workId, _repoId, _runId): Promise<PhaseFreshScope> {
    throw new DevtaskError("execute phase uses launchExecuteTask, not freshScope");
  },

  resumeScope(_paths, _workId, _repoId, _runId): PhaseScope {
    throw new DevtaskError("execute phase uses launchExecuteTask, not resumeScope");
  },

  workspacePath(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("execute requires a repo id");
    const materialization = readWorkMaterialization(paths, workId);
    const task = materialization?.tasks.find((t) => t.repoId === repoId);
    if (!task) throw new DevtaskError(`No execute task exists for ${workId}/${repoId}`);
    return task.worktreePath;
  },

  async finalize(_paths, workId, repoId, sessionRecord): Promise<PhaseResult> {
    if (!repoId) throw new DevtaskError("execute finalizer requires a repo id");
    const resultPath = sessionRecord.artifacts.resultPath;
    if (!resultPath) throw new DevtaskError(`execute phase artifacts are incomplete for ${workId}/${repoId}`);
    const result = readTaskResult(resultPath);
    const known = result.status === "done" || result.status === "blocked" || result.status === "failed";
    return { status: known ? result.status : "failed", artifacts: { resultPath } };
  },

  async attach(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("execute attach requires a repo id");
    const dir = phaseRunDir(paths, workId, "execute", repoId);
    const run = readRunningPhaseRun(dir);
    const scope = `${workId}/${repoId}`;
    if (run?.status === "running" && tmuxSessionExists(run.tmuxSession ?? "")) {
      throw new DevtaskError(`Execute session for ${scope} is running as ${run.tmuxSession!}. Use 'tmux attach -t ${run.tmuxSession!}' to view it.`);
    }
    if (!run) throw new DevtaskError(`No execute session exists for ${scope}`);
    throw new DevtaskError(`The latest execute session for ${scope} is not running`);
  },

  sendFeedback(paths, workId, repoId, message) {
    if (!repoId) throw new DevtaskError("execute feedback requires a repo id");
    const dir = phaseRunDir(paths, workId, "execute", repoId);
    const run = readRunningPhaseRun(dir);
    const scope = `${workId}/${repoId}`;
    if (!run || run.status !== "running" || !tmuxSessionExists(run.tmuxSession ?? "")) {
      throw new DevtaskError(`No running execute session for ${scope}`);
    }
    sendToTmuxSessionWithConfirmation(run.tmuxSession!, message, { lines: 60 });
    return Promise.resolve({
      phase: "execute",
      workId,
      repoId,
      taskId: run.taskId,
      status: "running" as const,
      tmuxSession: run.tmuxSession!,
      promptPath: run.promptPath,
      outputPath: run.outputPath ?? ""
    });
  },

  reset(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("execute reset requires a repo id");
    const dir = phaseRunDir(paths, workId, "execute", repoId);
    updateRunningPhaseRun(dir, { status: "cancelled", updatedAt: new Date().toISOString() });
  }
};

export function freshExecuteWork(paths: DevtaskPaths, workId: string, repoId: string): void {
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
}

export async function runExecuteWork(paths: DevtaskPaths, workId: string): Promise<ExecuteWorkResult> {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new Error(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  }
  const tasks: ExecuteTaskResult[] = [];

  for (const task of materialization.tasks) {
    tasks.push(await executeMaterializedTask(paths, workId, task));
  }

  const result: ExecuteWorkResult = {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
  const dir = workItemResultsDir(paths, workId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/execute.json`, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function summarizeExecuteWorkStatus(
  tasks: ExecuteTaskResult[]
): "failed" | "blocked" | "review-ready" | "executing" {
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.every((task) => task.status === "done")) return "review-ready";
  return "executing";
}

export function sendRawExecuteFeedback(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  message: string
): { confirmed: boolean; output: string } {
  const dir = phaseRunDir(paths, workId, "execute", repoId);
  const run = readRunningPhaseRun(dir);
  const scope = `${workId}/${repoId}`;
  if (!run || run.status !== "running" || !tmuxSessionExists(run.tmuxSession ?? "")) {
    throw new DevtaskError(`No running execute session for ${scope}`);
  }
  return sendToTmuxSessionWithConfirmation(run.tmuxSession!, message, { lines: 60 });
}

async function executeMaterializedTask(
  workspacePaths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number]
): Promise<ExecuteTaskResult> {
  const repoPaths = resolvePaths(task.repoPath);
  const storagePaths = taskStoragePaths(workspacePaths, task.repoPath);
  const metaPath = taskMetaPath(storagePaths, task.taskId);
  let meta = readTaskMeta(metaPath);
  const current = deriveExecutionStatus(meta);

  if (current.terminal) {
    meta = persistExecutionMeta(metaPath, {
      ...meta,
      status: current.status,
      resultSummary: current.summary,
      runtime: {
        state: "completed",
        reason: current.summary ?? `task ${current.status}`,
        lastObservedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    });
    writeExecutePhaseRun(workspacePaths, workId, task, meta, current.status);
    const existingRun = readRunningPhaseRun(phaseRunDir(workspacePaths, workId, "execute", task.repoId));
    if (existingRun) {
      updateRunningPhaseRun(phaseRunDir(workspacePaths, workId, "execute", task.repoId), {
        status: current.status === "blocked" ? "blocked" : current.status === "failed" ? "failed" : "completed",
        updatedAt: meta.updatedAt,
        session: {
          ...existingRun.session,
          summary: meta.resultSummary,
          summaryIsFallback: true
        }
      });
    }
    return {
      repoId: task.repoId,
      taskId: task.taskId,
      status: current.status,
      action: "skipped",
      sessionName: meta.tmuxSession,
      summary: meta.resultSummary,
      worktreePath: task.worktreePath
    };
  }

  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    meta = persistExecutionMeta(metaPath, {
      ...meta,
      status: "running",
      runtime: {
        state: "alive",
        reason: "execution session is active",
        lastObservedAt: new Date().toISOString()
      }
    });
    writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
    recordExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, meta.tmuxSession!, {
      promptPath: meta.taskPath,
      outputPath: meta.statePath,
      resultPath: meta.resultPath,
      updatedAt: meta.updatedAt,
      summary: meta.resultSummary,
      provider: readConfig(workspacePaths).agent.provider,
      providerSessionId: meta.agentSessionId,
      conversationId: meta.agentThreadId
    });
    return {
      repoId: task.repoId,
      taskId: task.taskId,
      status: "running",
      action: "reattached",
      sessionName: meta.tmuxSession,
      summary: meta.resultSummary,
      worktreePath: task.worktreePath
    };
  }

  const previousStatus = meta.status;
  const sessionName = meta.tmuxSession ?? tmuxSessionName(repoPaths, task.taskId);
  launchExecutionSession(workspacePaths, task.repoId, sessionName, meta);
  if (!waitForTmuxSession(sessionName, { attempts: 5, intervalMs: 200 })) {
    throw new DevtaskError(`Execution session ${sessionName} failed to start for ${task.taskId}`);
  }

  meta = persistExecutionMeta(metaPath, {
    ...meta,
    status: "running",
    tmuxSession: sessionName,
    agentSessionMode: "direct",
    resultSummary: "execution session started",
    runtime: {
      state: "alive",
      reason: "execution session is active",
      lastObservedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  });
  writeExecutePhaseRun(workspacePaths, workId, task, meta, "running");
  recordExecutePhaseSession(workspacePaths, workId, task.repoId, task.taskId, sessionName, {
    promptPath: meta.taskPath,
    outputPath: meta.statePath,
    resultPath: meta.resultPath,
    updatedAt: meta.updatedAt,
    summary: meta.resultSummary,
    provider: readConfig(workspacePaths).agent.provider,
    providerSessionId: meta.agentSessionId,
    conversationId: meta.agentThreadId
  });
  return {
    repoId: task.repoId,
    taskId: task.taskId,
    status: "running",
    action: previousStatus === "paused" || previousStatus === "running" ? "resumed" : "started",
    sessionName,
    summary: meta.resultSummary,
    worktreePath: task.worktreePath
  };
}

function launchExecutionSession(workspacePaths: DevtaskPaths, repoId: string, sessionName: string, meta: TaskMeta): void {
  const executionTaskPath = buildExecutionTaskPath(workspacePaths, repoId, meta);
  createBareSession(sessionName, meta.worktreePath);
  const scriptPath = writeLaunchScript([
    `cd ${shellEscape(meta.worktreePath)}`,
    `export DEVTASK_TASK_DIR=${shellEscape(path.dirname(meta.taskPath))}`,
    `export DEVTASK_TASK_PATH=${shellEscape(executionTaskPath)}`,
    `export DEVTASK_STATE_PATH=${shellEscape(meta.statePath)}`,
    `export DEVTASK_RESULT_PATH=${shellEscape(meta.resultPath)}`,
    `exec ${meta.command}`
  ].join("\n"));
  sendLaunchCommand(sessionName, `bash ${shellEscape(scriptPath)}`);
}

function buildExecutionTaskPath(workspacePaths: DevtaskPaths, repoId: string, meta: TaskMeta): string {
  const memory = collectPhaseMemory(workspacePaths, "implementation", { repoId });
  if (!memory) {
    return meta.taskPath;
  }
  const executionTaskPath = path.join(path.dirname(meta.taskPath), "task.execute.md");
  const original = readTextIfExists(meta.taskPath).trim();
  fs.writeFileSync(executionTaskPath, [original, "", memory].join("\n"));
  return executionTaskPath;
}

function deriveExecutionStatus(meta: TaskMeta): {
  status: ExecuteTaskResult["status"];
  terminal: boolean;
  summary: string | null;
} {
  const result = readTaskResult(meta.resultPath);
  if (result.status === "done") return { status: "done", terminal: true, summary: result.summary };
  if (result.status === "blocked") return { status: "blocked", terminal: true, summary: result.summary };
  if (result.status === "failed") return { status: "failed", terminal: true, summary: result.summary };
  if (meta.tmuxSession && tmuxSessionExists(meta.tmuxSession)) {
    return { status: "running", terminal: false, summary: meta.resultSummary };
  }
  return { status: "paused", terminal: false, summary: meta.resultSummary };
}

function readTaskResult(resultPath: string): { status: string; summary: string | null } {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown; reason?: unknown; summary?: unknown };
    const status = typeof value.status === "string" ? value.status : "pending";
    const summarySource = typeof value.reason === "string" ? value.reason : typeof value.summary === "string" ? value.summary : null;
    return { status, summary: summarySource?.trim() || null };
  } catch {
    return { status: "pending", summary: null };
  }
}

function persistExecutionMeta(metaPath: string, meta: TaskMeta): TaskMeta {
  writeTaskMeta(metaPath, meta);
  return meta;
}

function writeExecutePhaseRun(
  workspacePaths: DevtaskPaths,
  workId: string,
  task: WorkMaterialization["tasks"][number],
  meta: TaskMeta,
  status: string
): void {
  const provider = readConfig(workspacePaths).agent.provider;
  const runId = newRunId();
  writePhaseRunRecord(phaseRunDir(workspacePaths, workId, "execute", task.repoId), {
    schemaVersion: 1,
    phase: "execute",
    runId,
    workId,
    repoId: task.repoId,
    taskId: task.taskId,
    status,
    promptPath: meta.taskPath,
    outputPath: meta.statePath,
    startedAt: meta.updatedAt,
    finishedAt: meta.updatedAt,
    session: {
      provider,
      transportId: meta.tmuxSession,
      resumeContext: {
        providerSessionId: meta.agentSessionId ?? null,
        conversationId: meta.agentThreadId ?? null,
        resumeTarget: meta.agentSessionId ?? null,
        storageRoot: null,
        transcriptPath: null
      },
      summary: meta.resultSummary,
      summaryIsFallback: true
    },
    artifacts: {
      taskPath: meta.taskPath,
      statePath: meta.statePath,
      resultPath: meta.resultPath
    },
    exitCode: null
  });
}

function recordExecutePhaseSession(
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
    artifacts: { taskPath: meta.promptPath, statePath: meta.outputPath, resultPath: meta.resultPath },
    session: sessionRef
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(updated, null, 2)}\n`);
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
