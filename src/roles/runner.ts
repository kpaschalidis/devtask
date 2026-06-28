import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun, resolveSessionRef, writeRunningPhaseRun, type SessionRun, type SessionPhase } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import {
  attachTmuxSession,
  killTmuxSession,
  startPipePane,
  tmuxSessionExists,
} from "../adapters/agent-kernel/tmux-control.js";
import { DevtaskError } from "../infra/errors.js";
import { resumeKernelPhaseSession, startKernelPhaseSession } from "../adapters/agent-kernel/phase-session.js";
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
    const scopeLabel = repoId ? `${workId}/${repoId}` : workId;
    throw new DevtaskError(
      `Cannot resume ${phase} for ${scopeLabel} because the last session predates the kernel-backed runtime. ` +
      `Start a fresh ${phase} run instead.`
    );
  }
  const startedAt = new Date().toISOString();
  const resolvedPrompt = prompt ?? buildResumePrompt(phase, previous.provider);
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
) : { provider: "codex" | "cursor" | "claude-code"; taskId: string | null; kernelSession: NonNullable<SessionRun["kernelSession"]> | null } {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (current) {
    const kernelSession = current.kernelSession ?? synthesizeKernelSession(current);
    if (kernelSession) {
      return {
        provider: resolveSessionRef({ session: current.session, kernelSession }).provider,
        taskId: current.taskId,
        kernelSession,
      };
    }
  }
  const latest = getLatestWorkPhaseRun(paths, workId, phase, repoId ?? undefined);
  if (latest) {
    const kernelSession = latest.kernelSession ?? synthesizeKernelSession(latest);
    if (kernelSession) {
      return {
        provider: resolveSessionRef({ session: latest.session, kernelSession }).provider,
        taskId: latest.taskId,
        kernelSession,
      };
    }
  }
  throw new DevtaskError(
    `No resumable ${phase} session exists for ${repoId ? `${workId}/${repoId}` : workId}`
  );
}

function synthesizeKernelSession(
  run: { tmuxSession?: string | null; session: SessionRun["session"] },
): NonNullable<SessionRun["kernelSession"]> | null {
  const resume = run.session.resumeContext;
  const threadId = resume.providerSessionId ?? resume.conversationId ?? resume.resumeTarget ?? null;
  const transportId = run.tmuxSession ?? run.session.transportId ?? null;
  if (!threadId && !transportId && !resume.storageRoot && !resume.transcriptPath) {
    return null;
  }
  return {
    runtimeSessionId: transportId ?? "unknown",
    runtimeName: "tmux",
    threadId,
    data: {
      sessionName: transportId,
      threadId,
      codexHome: resume.storageRoot ?? null,
      transcriptPath: resume.transcriptPath ?? null,
      agentName: run.session.provider,
    },
  };
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

export function buildFeedbackPrompt(phase: string, feedback: string, provider: "codex" | "cursor" | "claude-code"): string {
  return [
    `Continue the ${phase} task using the existing ${provider} session context.`,
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

function buildResumePrompt(phase: string, provider: "codex" | "cursor" | "claude-code"): string {
  return [
    `Continue the ${phase} task using the existing ${provider} session context.`,
    "",
    "Review the current phase artifacts and continue the session from where it left off."
  ].join("\n");
}

function buildDevtaskCommand(args: string[]): string {
  const escaped = args.map((v) => shellEscape(v)).join(" ");
  const entry = shellEscape(path.resolve(process.cwd(), "dist/bin/devtask.js"));
  return `${shellEscape(process.execPath)} ${entry} ${escaped}`;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
