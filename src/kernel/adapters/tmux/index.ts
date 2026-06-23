import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
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
