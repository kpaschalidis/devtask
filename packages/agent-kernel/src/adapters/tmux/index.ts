import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Runtime, RuntimeHandle, RuntimeCreateConfig, AttachInfo } from '../../runtime/runtime.js';
import { normalizeArtifactPrefix, type ArtifactNamingConfig } from '../../shared/naming.js';
import { shellEscape } from '../../shared/shell.js';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const TMUX_TIMEOUT_MS = 5_000;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

// ─── Private helpers ──────────────────────────────────────────────────────────

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid tmux session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT_MS });
  return stdout.trimEnd();
}

/**
 * Write a self-deleting bash launch script to a temp file and return the
 * invocation string. Used when the command is too long to pass directly via
 * `tmux send-keys` without triggering terminal buffer issues.
 */
function writeLaunchScript(command: string, artifactPrefix: string): string {
  const scriptPath = join(tmpdir(), `${artifactPrefix}-launch-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${command}\n`, {
    encoding: 'utf-8',
    mode: 0o700,
  });
  return `bash ${shellEscape(scriptPath)}`;
}

export function isTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function tmuxSessionExists(session: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
  return result.status === 0;
}

export function waitForTmuxSession(session: string, options: { attempts?: number; intervalMs?: number } = {}): boolean {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 200;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (tmuxSessionExists(session)) return true;
    sleepSync(intervalMs);
  }
  return false;
}

export function attachTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new Error(`tmux session ${session} does not exist`);
  }
  const result = spawnSync('tmux', ['attach-session', '-t', session], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to attach tmux session ${session}`);
  }
}

export function createBareTmuxSession(session: string, cwd: string): void {
  assertTmuxAvailable();
  if (tmuxSessionExists(session)) {
    throw new Error(`tmux session ${session} already exists`);
  }
  const result = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', cwd], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to create bare tmux session ${session}`);
  }
}

export function startTmuxSession(session: string, command: string[], cwd: string): void {
  assertTmuxAvailable();
  if (tmuxSessionExists(session)) {
    throw new Error(`tmux session ${session} already exists`);
  }
  const result = spawnSync('tmux', ['new-session', '-d', '-s', session, ...command], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to start tmux session ${session}`);
  }
}

export function killTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) return;
  const result = spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to kill tmux session ${session}`);
  }
}

export function captureTmuxSession(session: string, lines = 30): string {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new Error(`tmux session ${session} does not exist`);
  }
  const result = spawnSync('tmux', ['capture-pane', '-t', session, '-p', '-S', `-${lines}`], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to capture tmux session ${session}`);
  }
  return result.stdout;
}

export function sendToTmuxSession(session: string, message: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new Error(`tmux session ${session} does not exist`);
  }
  runTmux(['send-keys', '-t', session, 'C-u'], `Failed to clear tmux session ${session}`);
  if (message.includes('\n') || message.length > 200) {
    const bufferName = `agent-${crypto.randomUUID()}`;
    const tmpPath = join(tmpdir(), `agent-send-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpPath, message, { encoding: 'utf8', mode: 0o600 });
    try {
      runTmux(['load-buffer', '-b', bufferName, tmpPath], `Failed to load tmux buffer for ${session}`);
      runTmux(['paste-buffer', '-b', bufferName, '-t', session, '-d'], `Failed to paste tmux buffer into ${session}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      runTmuxBestEffort(['delete-buffer', '-b', bufferName]);
    }
  } else {
    runTmux(['send-keys', '-t', session, '-l', message], `Failed to send message to tmux session ${session}`);
  }
  runTmux(['send-keys', '-t', session, 'Enter'], `Failed to submit message to tmux session ${session}`);
}

export function sendToTmuxSessionWithConfirmation(
  session: string,
  message: string,
  options: { lines?: number; attempts?: number; intervalMs?: number } = {},
): { confirmed: boolean; output: string } {
  const lines = options.lines ?? 30;
  const attempts = options.attempts ?? 6;
  const intervalMs = options.intervalMs ?? 500;
  const before = captureTmuxSession(session, lines);
  sendToTmuxSession(session, message);
  let output = captureTmuxSession(session, lines);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (output !== before || output.includes('Press up to edit queued messages')) {
      return { confirmed: true, output };
    }
    sleepSync(intervalMs);
    output = captureTmuxSession(session, lines);
  }
  return { confirmed: false, output };
}

export function writeTmuxLaunchScript(content: string, artifactPrefix = 'agent'): string {
  const scriptPath = join(tmpdir(), `${artifactPrefix}-launch-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${content}\n`, {
    encoding: 'utf8',
    mode: 0o700,
  });
  return scriptPath;
}

export function sendTmuxLaunchCommand(session: string, command: string): void {
  assertTmuxAvailable();
  runTmux(['send-keys', '-t', session, '-l', command], `Failed to send launch command to ${session}`);
  runTmux(['send-keys', '-t', session, 'Enter'], `Failed to submit launch command to ${session}`);
}

export async function isTmuxSessionAlive(session: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', session);
    return true;
  } catch {
    return false;
  }
}

export async function captureTmuxOutput(session: string, lines = 50): Promise<string> {
  try {
    return await tmux('capture-pane', '-t', session, '-p', '-S', `-${lines}`);
  } catch {
    return '';
  }
}

export async function getTmuxForegroundCommand(session: string): Promise<string | null> {
  try {
    const output = await tmux('display-message', '-p', '-t', session, '#{pane_current_command}');
    return output.trim() || null;
  } catch {
    return null;
  }
}

export async function sendTmuxMessage(session: string, message: string): Promise<void> {
  await tmux('send-keys', '-t', session, 'C-u');
  if (message.includes('\n') || message.length > 200) {
    const bufferName = `agent-${crypto.randomUUID()}`;
    const tmpPath = join(tmpdir(), `agent-send-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpPath, message, { encoding: 'utf8', mode: 0o600 });
    try {
      await tmux('load-buffer', '-b', bufferName, tmpPath);
      await tmux('paste-buffer', '-p', '-b', bufferName, '-t', session, '-d');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      try { await tmux('delete-buffer', '-b', bufferName); } catch { /* ignore */ }
    }
    await sleep(500);
  } else {
    await tmux('send-keys', '-t', session, '-l', message);
    await sleep(300);
  }
  await tmux('send-keys', '-t', session, 'Enter');
}

export async function startPipePane(session: string, logPath: string): Promise<void> {
  try {
    const quotedPath = `'${logPath}'`;
    await tmux('pipe-pane', '-t', session, '-o', `cat >> ${quotedPath}`);
  } catch {
    // best effort
  }
}

function assertTmuxAvailable(): void {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available on this system');
  }
}

function runTmux(args: string[], errorMessage: string): void {
  const result = spawnSync('tmux', args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error(errorMessage);
  }
}

function runTmuxBestEffort(args: string[]): void {
  spawnSync('tmux', args, { stdio: 'ignore' });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── TmuxSession ──────────────────────────────────────────────────────────────

/**
 * Encapsulates a single named tmux session. Obtain an instance via
 * `TmuxSession.create()`; the static factory creates the session and validates
 * the name before returning.
 */
export class TmuxSession {
  constructor(
    private readonly name: string,
    private readonly env: Record<string, string> = {},
    private readonly artifactPrefix = 'agent',
  ) {}

  /**
   * Create a new detached tmux session with the given name, working directory,
   * and optional environment variables, then return a `TmuxSession` bound to it.
   */
  static async create(
    name: string,
    workingDir: string,
    env: Record<string, string> = {},
    artifactPrefix = 'agent',
  ): Promise<TmuxSession> {
    assertValidSessionId(name);
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      envArgs.push('-e', `${k}=${v}`);
    }
    await tmux('new-session', '-d', '-s', name, '-c', workingDir, ...envArgs);
    return new TmuxSession(name, env, artifactPrefix);
  }

  /** The underlying tmux session name. */
  get sessionName(): string {
    return this.name;
  }

  /**
   * Send a shell command to the session. For long commands a self-deleting
   * temp script is used to avoid terminal buffer truncation.
   *
   * Also re-exports PATH inside the command so macOS `zsh` does not wipe
   * custom PATH entries via `path_helper` on shell startup.
   */
  async sendLaunchCommand(command: string): Promise<void> {
    let cmd = command;
    const pathValue = this.env['PATH'] ?? process.env['PATH'];
    if (pathValue) {
      cmd = `export PATH=$(printf '%s' ${JSON.stringify(pathValue)})\n${cmd}`;
    }

    try {
      if (cmd.length > 200) {
        const invocation = writeLaunchScript(cmd, this.artifactPrefix);
        await tmux('send-keys', '-t', this.name, '-l', invocation);
        await sleep(300);
        await tmux('send-keys', '-t', this.name, 'Enter');
      } else {
        await tmux('send-keys', '-t', this.name, cmd, 'Enter');
      }
    } catch (err) {
      try { await tmux('kill-session', '-t', this.name); } catch { /* best-effort */ }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to launch in tmux session "${this.name}": ${msg}`, { cause: err });
    }
  }

  /**
   * Send an arbitrary message as keyboard input to the session. Handles long
   * and multiline messages via `tmux load-buffer` + `paste-buffer` to avoid
   * terminal buffer limitations.
   */
  async sendMessage(message: string): Promise<void> {
    // Clear any partial input first
    await tmux('send-keys', '-t', this.name, 'C-u');

    if (message.includes('\n') || message.length > 200) {
      const bufferName = `${this.artifactPrefix}-buffer-${crypto.randomUUID()}`;
      const tmpPath = join(tmpdir(), `${this.artifactPrefix}-send-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpPath, message, { encoding: 'utf-8', mode: 0o600 });
      try {
        await tmux('load-buffer', '-b', bufferName, tmpPath);
        await tmux('paste-buffer', '-b', bufferName, '-t', this.name, '-d');
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        try { await tmux('delete-buffer', '-b', bufferName); } catch { /* may already be deleted by -d */ }
      }
    } else {
      // Use -l (literal) so text like "Enter" or "Space" isn't interpreted as tmux key names
      await tmux('send-keys', '-t', this.name, '-l', message);
    }

    // Small delay before Enter so tmux fully processes the pasted text
    await sleep(300);
    await tmux('send-keys', '-t', this.name, 'Enter');
  }

  /**
   * Return `true` when the tmux session is still running, `false` if it has
   * exited or was killed.
   */
  async isAlive(): Promise<boolean> {
    try {
      await tmux('has-session', '-t', this.name);
      return true;
    } catch {
      return false;
    }
  }

  /** Kill the tmux session. Errors are swallowed if the session is already gone. */
  async kill(): Promise<void> {
    try {
      await tmux('kill-session', '-t', this.name);
    } catch { /* session may already be dead */ }
  }

  async captureOutput(lines = 50): Promise<string> {
    try {
      return await tmux('capture-pane', '-t', this.name, '-p', '-S', `-${lines}`);
    } catch {
      return '';
    }
  }

  async isProcessRunning(processName: string): Promise<boolean> {
    try {
      const ttyOut = await tmux('list-panes', '-t', this.name, '-F', '#{pane_tty}');
      const ttys = ttyOut
        .trim()
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return false;

      const { stdout: psOut } = await execFileAsync('ps', ['-eo', 'pid,tty,args'], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, '')));
      const processRe = new RegExp(`(?:^|/)${escapeRegExp(processName)}(?:\\s|$)`);
      for (const line of psOut.split('\n')) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? '')) continue;
        const args = cols.slice(2).join(' ');
        if (processRe.test(args)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ─── TmuxRuntime ─────────────────────────────────────────────────────────────

export class TmuxRuntime implements Runtime {
  readonly name = 'tmux';
  private readonly artifactPrefix: string;

  constructor(config: ArtifactNamingConfig = {}) {
    this.artifactPrefix = normalizeArtifactPrefix(config.artifactPrefix, 'agent');
  }

  async preflight(): Promise<void> {
    try {
      await tmux('-V');
    } catch {
      throw new Error('tmux is not available on this system');
    }
  }

  async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
    const session = await TmuxSession.create(
      config.sessionId,
      config.workspacePath,
      config.environment,
      this.artifactPrefix,
    );
    await session.sendLaunchCommand(config.launchCommand);
    return {
      id: config.sessionId,
      runtimeName: this.name,
      data: { sessionName: config.sessionId, workspacePath: config.workspacePath },
    };
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    await this.sessionFrom(handle).kill();
  }

  async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
    await this.sessionFrom(handle).sendMessage(message);
  }

  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    return this.sessionFrom(handle).isAlive();
  }

  async isProcessRunning(handle: RuntimeHandle, processName: string): Promise<boolean> {
    return this.sessionFrom(handle).isProcessRunning(processName);
  }

  async captureOutput(handle: RuntimeHandle, lines?: number): Promise<string> {
    return this.sessionFrom(handle).captureOutput(lines);
  }

  getAttachInfo(handle: RuntimeHandle): AttachInfo {
    const sessionName = handle.data['sessionName'] as string;
    return {
      command: `tmux attach -t ${sessionName}`,
      description: `Attach to tmux session "${sessionName}"`,
    };
  }

  private sessionFrom(handle: RuntimeHandle): TmuxSession {
    return new TmuxSession(handle.data['sessionName'] as string, {}, this.artifactPrefix);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { shellEscape };
