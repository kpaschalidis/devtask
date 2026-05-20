import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { DevtaskError } from "./errors.js";

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;

export function tmuxSessionName(paths: DevtaskPaths, taskId: string): string {
  const repoName = path.basename(paths.root).replace(/[^A-Za-z0-9_-]/g, "-");
  const rootHash = crypto.createHash("sha1").update(paths.root).digest("hex").slice(0, 8);
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `devtask-${repoName}-${rootHash}-${safeTaskId}`;
}

export function assertTmuxAvailable(): void {
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError("tmux is not available. Install tmux or run in plain mode.");
  }
}

export function isTmuxAvailable(): boolean {
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export function tmuxSessionExists(session: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
  return result.status === 0;
}

export function startTmuxSession(session: string, command: string[], cwd: string): void {
  assertTmuxAvailable();
  if (tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} already exists`);
  }

  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, ...command], {
    cwd,
    stdio: "inherit"
  });

  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to start tmux session ${session}`);
  }
}

export function waitForTmuxSession(session: string, options: { attempts?: number; intervalMs?: number } = {}): boolean {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 200;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (tmuxSessionExists(session)) {
      return true;
    }
    sleepSync(intervalMs);
  }
  return false;
}

export function attachTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} does not exist`);
  }

  process.stderr.write("Attaching to tmux session. Press Ctrl+b d to detach without stopping the agent.\n");
  const result = spawnSync("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to attach tmux session ${session}`);
  }
}

export function killTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    return;
  }

  const result = spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to kill tmux session ${session}`);
  }
}

export function captureTmuxSession(session: string, lines = 30): string {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} does not exist`);
  }

  const result = spawnSync("tmux", ["capture-pane", "-t", session, "-p", "-S", `-${lines}`], {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to capture tmux session ${session}`);
  }
  return result.stdout;
}

export function sendToTmuxSession(session: string, message: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} does not exist`);
  }

  runTmux(["send-keys", "-t", session, "C-u"], `Failed to clear tmux session ${session}`);

  if (message.includes("\n") || message.length > 200) {
    const bufferName = `devtask-${crypto.randomUUID()}`;
    const tmpPath = path.join(os.tmpdir(), `devtask-send-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpPath, message, { encoding: "utf8", mode: 0o600 });
    try {
      runTmux(["load-buffer", "-b", bufferName, tmpPath], `Failed to load tmux buffer for ${session}`);
      runTmux(["paste-buffer", "-b", bufferName, "-t", session, "-d"], `Failed to paste tmux buffer into ${session}`);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      runTmuxBestEffort(["delete-buffer", "-b", bufferName]);
    }
  } else {
    runTmux(["send-keys", "-t", session, "-l", message], `Failed to send message to tmux session ${session}`);
  }

  runTmux(["send-keys", "-t", session, "Enter"], `Failed to submit message to tmux session ${session}`);
}

export function sendToTmuxSessionWithConfirmation(
  session: string,
  message: string,
  options: { lines?: number; attempts?: number; intervalMs?: number } = {}
): { confirmed: boolean; output: string } {
  const lines = options.lines ?? 30;
  const attempts = options.attempts ?? 6;
  const intervalMs = options.intervalMs ?? 500;
  const before = captureTmuxSession(session, lines);
  sendToTmuxSession(session, message);

  let output = captureTmuxSession(session, lines);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (output !== before || output.includes("Press up to edit queued messages")) {
      return { confirmed: true, output };
    }
    sleepSync(intervalMs);
    output = captureTmuxSession(session, lines);
  }

  return { confirmed: false, output };
}

export function createBareSession(session: string, cwd: string): void {
  assertTmuxAvailable();
  if (tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} already exists`);
  }
  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd], {
    stdio: "inherit"
  });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to create bare tmux session ${session}`);
  }
}

export function sendLaunchCommand(session: string, command: string): void {
  assertTmuxAvailable();
  runTmux(["send-keys", "-t", session, "-l", command], `Failed to send launch command to ${session}`);
  runTmux(["send-keys", "-t", session, "Enter"], `Failed to submit launch command to ${session}`);
}

export function writeLaunchScript(content: string): string {
  const scriptPath = path.join(os.tmpdir(), `devtask-launch-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${content}\n`, {
    encoding: "utf8",
    mode: 0o700
  });
  return scriptPath;
}

async function tmuxAsync(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout: TMUX_TIMEOUT_MS });
  return stdout.trimEnd();
}

export async function isSessionAliveAsync(session: string): Promise<boolean> {
  try {
    await tmuxAsync("has-session", "-t", session);
    return true;
  } catch {
    return false;
  }
}

export async function captureOutputAsync(session: string, lines = 50): Promise<string> {
  try {
    return await tmuxAsync("capture-pane", "-t", session, "-p", "-S", `-${lines}`);
  } catch {
    return "";
  }
}

export async function getForegroundCommand(session: string): Promise<string | null> {
  try {
    const output = await tmuxAsync("display-message", "-p", "-t", session, "#{pane_current_command}");
    return output.trim() || null;
  } catch {
    return null;
  }
}

export async function sendMessageAsync(session: string, message: string): Promise<void> {
  await tmuxAsync("send-keys", "-t", session, "C-u");

  if (message.includes("\n") || message.length > 200) {
    const bufferName = `devtask-${crypto.randomUUID()}`;
    const tmpPath = path.join(os.tmpdir(), `devtask-send-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpPath, message, { encoding: "utf8", mode: 0o600 });
    try {
      await tmuxAsync("load-buffer", "-b", bufferName, tmpPath);
      // -p = bracket-paste mode: content arrives as one atomic event, not per-keystroke.
      await tmuxAsync("paste-buffer", "-p", "-b", bufferName, "-t", session, "-d");
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      try { await tmuxAsync("delete-buffer", "-b", bufferName); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  } else {
    await tmuxAsync("send-keys", "-t", session, "-l", message);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }

  await tmuxAsync("send-keys", "-t", session, "Enter");
}

export async function sendKeyAsync(session: string, key: string): Promise<void> {
  await tmuxAsync("send-keys", "-t", session, key);
}

export async function startPipePane(session: string, logPath: string): Promise<void> {
  try {
    // Single-quote the path; log paths are ISO timestamps so never contain single quotes
    const quotedPath = `'${logPath}'`;
    await tmuxAsync("pipe-pane", "-t", session, "-o", `cat >> ${quotedPath}`);
  } catch {
    // Best-effort: if pipe-pane fails, run log will simply be empty
  }
}

function runTmux(args: string[], errorMessage: string): void {
  const result = spawnSync("tmux", args, { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(errorMessage);
  }
}

function runTmuxBestEffort(args: string[]): void {
  spawnSync("tmux", args, { stdio: "ignore" });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
