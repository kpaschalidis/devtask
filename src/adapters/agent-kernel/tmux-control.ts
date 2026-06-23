import crypto from "node:crypto";
import path from "node:path";
import {
  attachTmuxSession as kernelAttachTmuxSession,
  captureTmuxOutput,
  captureTmuxSession as kernelCaptureTmuxSession,
  createBareTmuxSession,
  getTmuxForegroundCommand,
  isTmuxAvailable,
  isTmuxSessionAlive,
  killTmuxSession as kernelKillTmuxSession,
  sendTmuxLaunchCommand,
  sendTmuxMessage,
  sendToTmuxSession as kernelSendToTmuxSession,
  sendToTmuxSessionWithConfirmation as kernelSendToTmuxSessionWithConfirmation,
  startPipePane,
  startTmuxSession as kernelStartTmuxSession,
  tmuxSessionExists,
  TmuxRuntime,
  waitForTmuxSession,
  writeTmuxLaunchScript,
} from "@devtask/agent-kernel";
import type { KernelSessionRef } from "../../infra/session-run.js";
import type { DevtaskPaths } from "../../infra/paths.js";
import { DevtaskError } from "../../infra/errors.js";

export { isTmuxAvailable, tmuxSessionExists, waitForTmuxSession, startPipePane };
export {
  captureTmuxOutput as captureOutputAsync,
  createBareTmuxSession as createBareSession,
  getTmuxForegroundCommand as getForegroundCommand,
  isTmuxSessionAlive as isSessionAliveAsync,
  sendTmuxLaunchCommand as sendLaunchCommand,
  sendTmuxMessage as sendMessageAsync,
  writeTmuxLaunchScript as writeLaunchScript,
};

export function tmuxSessionName(paths: DevtaskPaths, taskId: string): string {
  const repoName = path.basename(paths.root).replace(/[^A-Za-z0-9_-]/g, "-");
  const rootHash = crypto.createHash("sha1").update(paths.root).digest("hex").slice(0, 8);
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `devtask-${repoName}-${rootHash}-${safeTaskId}`;
}

export function assertTmuxAvailable(): void {
  if (!isTmuxAvailable()) {
    throw new DevtaskError("tmux is not available. Install tmux or run in plain mode.");
  }
}

export function startTmuxSession(session: string, command: string[], cwd: string): void {
  translateTmuxError(() => kernelStartTmuxSession(session, command, cwd));
}

export function attachTmuxSession(session: string): void {
  process.stderr.write("Attaching to tmux session. Press Ctrl+b d to detach without stopping the agent.\n");
  translateTmuxError(() => kernelAttachTmuxSession(session));
}

export function killTmuxSession(session: string): void {
  translateTmuxError(() => kernelKillTmuxSession(session));
}

export function captureTmuxSession(session: string, lines = 30): string {
  return translateTmuxError(() => kernelCaptureTmuxSession(session, lines));
}

export function sendToTmuxSession(session: string, message: string): void {
  translateTmuxError(() => kernelSendToTmuxSession(session, message));
}

export function sendToTmuxSessionWithConfirmation(
  session: string,
  message: string,
  options: { lines?: number; attempts?: number; intervalMs?: number } = {},
): { confirmed: boolean; output: string } {
  return translateTmuxError(() => kernelSendToTmuxSessionWithConfirmation(session, message, options));
}

export async function launchExecutionTmuxSession(config: {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
}): Promise<KernelSessionRef> {
  const runtime = new TmuxRuntime({ artifactPrefix: "devtask" });
  const handle = await runtime.create({
    sessionId: config.sessionId,
    workspacePath: config.workspacePath,
    launchCommand: config.launchCommand,
    environment: {},
  });
  return { runtimeSessionId: handle.id, runtimeName: handle.runtimeName, threadId: null, data: { ...handle.data } };
}

function translateTmuxError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DevtaskError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DevtaskError(message);
  }
}
