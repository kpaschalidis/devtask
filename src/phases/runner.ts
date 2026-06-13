import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import { createDefaultAgentRunner } from "../agent.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun, writeRunningPhaseRun, type PhaseRun, type PhaseRunPhase } from "../infra/phase-run.js";
import { newRunId } from "../infra/run-record.js";
import {
  attachTmuxSession,
  killTmuxSession,
  startPipePane,
  startTmuxSession,
  tmuxSessionExists,
  waitForTmuxSession,
  writeLaunchScript
} from "../infra/tmux.js";
import { DevtaskError } from "../infra/errors.js";
import { getLatestWorkPhaseRun } from "../services/phase-run-service.js";
import type { PhaseConfig, PhaseLaunchResult } from "./types.js";

export type { PhaseLaunchResult };

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
  config: PhaseConfig,
  paths: DevtaskPaths,
  workId: string,
  phase: PhaseRunPhase,
  repoId: string | null
): Promise<PhaseLaunchResult> {
  ensureNoLiveSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const devtaskConfig = readConfig(paths);
  const runner = createDefaultAgentRunner(devtaskConfig);
  const { scope, prompt, startOptions } = await config.freshScope(paths, workId, repoId, runId);
  const completionCommand = buildManagedCompletionCommand(paths, phase, workId, repoId, runId);
  const start = await runner.buildInteractiveStartCommand?.(
    { ...startOptions, managedCompletionCommand: completionCommand },
    prompt
  );
  if (!start) {
    throw new DevtaskError(`Provider ${devtaskConfig.agent.provider} does not support interactive ${phase} sessions`);
  }
  fs.mkdirSync(path.dirname(scope.promptPath), { recursive: true });
  fs.writeFileSync(scope.promptPath, `${prompt}\n`);
  launchInteractiveSession(scope.cwd, scope.tmuxSession, start.command);
  await startPipePane(scope.tmuxSession, scope.outputPath);
  const startedAt = new Date().toISOString();
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
      ...start.session,
      transportId: scope.tmuxSession,
      summary: `${phase} session started`,
      summaryIsFallback: true
    }
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

export async function launchPhaseResume(
  config: PhaseConfig,
  paths: DevtaskPaths,
  workId: string,
  phase: PhaseRunPhase,
  repoId: string | null,
  prompt?: string,
  trackCompletion = false
): Promise<PhaseLaunchResult> {
  ensureNoLiveSession(paths, workId, phase, repoId);
  const previous = readPreviousSession(paths, workId, phase, repoId);
  const runId = newRunId();
  const devtaskConfig = readConfig(paths);
  const runner = createDefaultAgentRunner(devtaskConfig);
  const scope = config.resumeScope(paths, workId, repoId, runId);
  const completionCommand = trackCompletion
    ? buildManagedCompletionCommand(paths, phase, workId, repoId, runId)
    : null;
  runner.installCompletionHook?.(previous.session, completionCommand);
  const command = runner.buildInteractiveResumeCommand?.(previous.session, {
    workspacePath: scope.cwd,
    model: devtaskConfig.codex.model ?? null,
    prompt: prompt ?? null,
    managedCompletionCommand: completionCommand
  });
  if (!command) {
    throw new DevtaskError(`Provider ${previous.session.provider} does not support interactive resume for ${phase}`);
  }
  const startedAt = new Date().toISOString();
  const resolvedPrompt = prompt ?? buildResumePrompt(phase, previous.session);
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
      ...previous.session,
      transportId: scope.tmuxSession,
      summary: `${phase} resume session started`,
      summaryIsFallback: true
    }
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

export function readPreviousSession(
  paths: DevtaskPaths,
  workId: string,
  phase: PhaseRunPhase,
  repoId: string | null
): { session: AgentSessionRef; taskId: string | null } {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (current && hasResumeContext(current.session)) {
    return { session: current.session, taskId: current.taskId };
  }
  const latest = getLatestWorkPhaseRun(paths, workId, phase, repoId ?? undefined);
  if (latest && hasResumeContext(latest.session)) {
    return { session: latest.session, taskId: latest.taskId };
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
  const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase as PhaseRunPhase, repoId));
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

export function killLiveSession(paths: DevtaskPaths, workId: string, phase: PhaseRunPhase, repoId: string | null): void {
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

function launchInteractiveSession(cwd: string, tmuxSession: string, command: string): void {
  if (tmuxSessionExists(tmuxSession)) {
    killTmuxSession(tmuxSession);
  }
  const scriptPath = writeLaunchScript([`cd ${shellEscape(cwd)}`, command].join("\n"));
  startTmuxSession(tmuxSession, ["bash", scriptPath], cwd);
  if (!waitForTmuxSession(tmuxSession, { attempts: 5, intervalMs: 200 })) {
    throw new DevtaskError(`Phase session ${tmuxSession} failed to start`);
  }
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
