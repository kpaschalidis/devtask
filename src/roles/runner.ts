import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { createDefaultAgentRunner } from "../agent.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun, writeRunningPhaseRun, type SessionRun, type SessionPhase } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import {
  attachTmuxSession,
  killTmuxSession,
  startPipePane,
  startTmuxSession,
  tmuxSessionExists,
  writeLaunchScript
} from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import { resumeKernelPhaseSession, startKernelPhaseSession } from "../kernel/devtask-phase-session.js";
import { getLatestWorkPhaseRun } from "../services/session-run-service.js";
import type { RoleConfig, RoleLaunchResult, FreshScopeOpts } from "./types.js";

export type { RoleLaunchResult };

export function buildManagedCompletionCommand(
  paths: DevtaskPaths,
  phase: string,
  workId: string,
  repoId: string | null,
  runId: string
): string {
  const args = repoId
    ? ["work", "_phase-finalize-hook", phase, workId, runId, repoId]
    : ["work", "_phase-finalize-hook", phase, workId, runId];
  return [
    `export DEVTASK_WORKSPACE_ROOT=${shellEscape(paths.root)}`,
    `exec ${buildDevtaskCommand(args)}`
  ].join("\n");
}

export async function launchPhaseFresh(
  config: RoleConfig,
  paths: DevtaskPaths,
  workId: string,
  phase: SessionPhase,
  repoId: string | null,
  opts?: FreshScopeOpts
): Promise<RoleLaunchResult> {
  ensureNoLiveSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const { scope, prompt, startOptions } = await config.freshScope(paths, workId, repoId, runId, opts);
  const completionCommand = buildManagedCompletionCommand(paths, phase, workId, repoId, runId);
  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${prompt}\n`);
  const launch = await startKernelPhaseSession({
    paths,
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    workspacePath: scope.cwd,
    prompt,
    tmuxSession: scope.tmuxSession,
    managedCompletionCommand: completionCommand,
    addDirs: startOptions.addDirs,
    taskDir: startOptions.env?.DEVTASK_TASK_DIR ?? null,
  });
  await startPipePane(launch.tmuxSession, scope.outputPath);
  const startedAt = new Date().toISOString();
  writeRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    runId,
    tmuxSession: launch.tmuxSession,
    startedAt,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath,
    artifacts: scope.artifacts,
    session: {
      ...launch.session,
      transportId: launch.tmuxSession,
      summary: `${phase} session started`,
      summaryIsFallback: true
    },
    kernelSession: launch.kernelSession
  });
  return {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    status: "started",
    tmuxSession: launch.tmuxSession,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath
  };
}

export async function launchPhaseResume(
  config: RoleConfig,
  paths: DevtaskPaths,
  workId: string,
  phase: SessionPhase,
  repoId: string | null,
  prompt?: string,
  trackCompletion = false
): Promise<RoleLaunchResult> {
  ensureNoLiveSession(paths, workId, phase, repoId);
  const previous = readPreviousSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const scope = config.resumeScope(paths, workId, repoId, runId);
  const completionCommand = trackCompletion
    ? buildManagedCompletionCommand(paths, phase, workId, repoId, runId)
    : null;
  if (!previous.kernelSession) {
    return launchLegacyPhaseResume(config, paths, workId, phase, repoId, scope, previous.session, completionCommand, prompt);
  }
  const startedAt = new Date().toISOString();
  const resolvedPrompt = prompt ?? buildResumePrompt(phase, previous.session);
  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${resolvedPrompt}\n`);
  const launch = await resumeKernelPhaseSession({
    paths,
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    workspacePath: scope.cwd,
    tmuxSession: scope.tmuxSession,
    kernelSession: previous.kernelSession,
    managedCompletionCommand: completionCommand,
    prompt: prompt ?? null
  });
  await startPipePane(launch.tmuxSession, scope.outputPath);
  writeRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    runId,
    tmuxSession: launch.tmuxSession,
    startedAt,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath,
    artifacts: scope.artifacts,
    session: {
      ...launch.session,
      transportId: launch.tmuxSession,
      summary: `${phase} resume session started`,
      summaryIsFallback: true
    },
    kernelSession: launch.kernelSession
  });
  return {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    status: "started",
    tmuxSession: launch.tmuxSession,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath
  };
}

export function readPreviousSession(
  paths: DevtaskPaths,
  workId: string,
  phase: SessionPhase,
  repoId: string | null
): { session: AgentSessionRef; taskId: string | null; kernelSession: NonNullable<SessionRun["kernelSession"]> | null } {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (current && hasResumeContext(current.session)) {
    return { session: current.session, taskId: current.taskId, kernelSession: current.kernelSession ?? null };
  }
  const latest = getLatestWorkPhaseRun(paths, workId, phase, repoId ?? undefined);
  if (latest && hasResumeContext(latest.session)) {
    return { session: latest.session, taskId: latest.taskId, kernelSession: latest.kernelSession ?? null };
  }
  throw new DevtaskError(
    `No resumable ${phase} session exists for ${repoId ? `${workId}/${repoId}` : workId}`
  );
}

export function ensureNoLiveSession(
  paths: DevtaskPaths,
  workId: string,
  phase: string,
  repoId: string | null
): void {
  const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase as SessionPhase, repoId));
  if (run?.status === "running" && tmuxSessionExists(run.tmuxSession ?? "")) {
    const scope = repoId ? `${workId}/${repoId}` : workId;
    const attach = repoId
      ? `devtask work ${phase} attach ${workId} ${repoId}`
      : `devtask work ${phase} attach ${workId}`;
    const feedback = repoId
      ? `devtask work ${phase} feedback ${workId} ${repoId} "<message>"`
      : `devtask work ${phase} feedback ${workId} "<message>"`;
    throw new DevtaskError(
      `${phase} is already running for ${scope}. Use ${attach} or ${feedback}.`
    );
  }
}

export function buildFeedbackPrompt(phase: string, feedback: string, session: AgentSessionRef): string {
  return [
    `Continue the ${phase} task using the existing ${session.provider} session context.`,
    "",
    "Update the existing artifact based on this feedback:",
    "",
    feedback.trim()
  ].join("\n");
}

export function killLiveSession(paths: DevtaskPaths, workId: string, phase: SessionPhase, repoId: string | null): void {
  const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (run?.status === "running" && tmuxSessionExists(run.tmuxSession ?? "")) {
    killTmuxSession(run.tmuxSession!);
  }
}

export { attachTmuxSession };

function buildResumePrompt(phase: string, session: AgentSessionRef): string {
  return [
    `Continue the ${phase} task using the existing ${session.provider} session context.`,
    "",
    "Review the current phase artifacts and continue the session from where it left off."
  ].join("\n");
}

function hasResumeContext(session: AgentSessionRef): boolean {
  return Object.values(session.resumeContext).some((v) => v !== null);
}

async function launchLegacyPhaseResume(
  config: RoleConfig,
  paths: DevtaskPaths,
  workId: string,
  phase: SessionPhase,
  repoId: string | null,
  scope: ReturnType<RoleConfig["resumeScope"]>,
  session: AgentSessionRef,
  completionCommand: string | null,
  prompt?: string,
): Promise<RoleLaunchResult> {
  const runId = path.basename(scope.promptPath).replace(/\.prompt\.md$/, "");
  const devtaskConfig = readConfig(paths);
  const runner = createDefaultAgentRunner(devtaskConfig);
  runner.installCompletionHook?.(session, completionCommand);
  const command = runner.buildInteractiveResumeCommand?.(session, {
    workspacePath: scope.cwd,
    model: devtaskConfig.codex.model ?? null,
    prompt: prompt ?? null,
    managedCompletionCommand: completionCommand
  });
  if (!command) {
    throw new DevtaskError(`Provider ${session.provider} does not support interactive resume for ${phase}`);
  }
  const startedAt = new Date().toISOString();
  const resolvedPrompt = prompt ?? buildResumePrompt(phase, session);
  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${resolvedPrompt}\n`);
  launchInteractiveSession(scope.cwd, scope.tmuxSession, command);
  await startPipePane(scope.tmuxSession, scope.outputPath);
  writeRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    runId,
    tmuxSession: scope.tmuxSession,
    startedAt,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath,
    artifacts: scope.artifacts,
    session: {
      ...session,
      transportId: scope.tmuxSession,
      summary: `${phase} resume session started`,
      summaryIsFallback: true
    },
    kernelSession: null
  });
  return {
    phase,
    workId,
    repoId,
    taskId: scope.taskId,
    status: "started",
    tmuxSession: scope.tmuxSession,
    promptPath: scope.promptPath,
    outputPath: scope.outputPath
  };
}

function launchInteractiveSession(cwd: string, tmuxSession: string, command: string): void {
  if (tmuxSessionExists(tmuxSession)) {
    killTmuxSession(tmuxSession);
  }
  const scriptPath = writeLaunchScript([`cd ${shellEscape(cwd)}`, command].join("\n"));
  startTmuxSession(tmuxSession, ["bash", scriptPath], cwd);
}

function buildDevtaskCommand(args: string[]): string {
  const escaped = args.map((v) => shellEscape(v)).join(" ");
  const entry = shellEscape(path.resolve(process.cwd(), "dist/bin/devtask.js"));
  return `node ${entry} ${escaped}`;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
