import crypto from 'node:crypto';
import fs, { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { readdir, stat, lstat, open } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentRunner, RunEvent, RunOptions, ActivityState } from '../core/ports/agent-runner.js';
import type { SessionHandle } from '../core/domain/run-attempt.js';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const TMUX_TIMEOUT_MS = 5_000;
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const SESSION_MATCH_SCAN_CHUNK_BYTES = 8192;
const SESSION_MATCH_SCAN_LINE_LIMIT = 10;
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const MAX_SESSION_SCAN_DEPTH = 4;
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALL_MS = 120_000;
const DEFAULT_MAX_TURN_MS = 600_000;
const JSONL_WAIT_MAX_MS = 30_000;
const JSONL_WAIT_POLL_MS = 500;

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

// ─── JSONL types ──────────────────────────────────────────────────────────────

interface CodexJsonlPayload {
  id?: string;
  cwd?: string;
  model?: string;
  threadId?: string;
  content?: string;
  type?: string;
}

interface CodexJsonlLine {
  type?: string;
  payload?: CodexJsonlPayload;
}

// ─── Internal session state ───────────────────────────────────────────────────

interface SessionState {
  workspacePath: string;
  jsonlPath: string | null;
  jsonlOffset: number;
}

// ─── tmux helpers (adapted from ao packages/plugins/runtime-tmux/src/index.ts) ─

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid tmux session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9/_.-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT_MS });
  return stdout.trimEnd();
}

function writeLaunchScript(command: string): string {
  const scriptPath = join(tmpdir(), `devtask-launch-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${command}\n`, {
    encoding: 'utf-8',
    mode: 0o700,
  });
  return `bash ${shellEscape(scriptPath)}`;
}

async function tmuxCreateSession(
  sessionName: string,
  workspacePath: string,
  env: Record<string, string>,
): Promise<void> {
  assertValidSessionId(sessionName);
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  await tmux('new-session', '-d', '-s', sessionName, '-c', workspacePath, ...envArgs);
}

async function tmuxSendLaunchCommand(sessionName: string, launchCommand: string): Promise<void> {
  // Re-export PATH inside the script. macOS zsh runs path_helper on shell startup
  // which resets PATH, wiping entries set via tmux -e. Embedding the export in a
  // temp script avoids terminal buffer issues with long PATH values (1000+ chars).
  let cmd = launchCommand;
  const pathValue = process.env['PATH'];
  if (pathValue) {
    cmd = `export PATH=$(printf '%s' ${JSON.stringify(pathValue)})\n${cmd}`;
  }

  try {
    if (cmd.length > 200) {
      const invocation = writeLaunchScript(cmd);
      await tmux('send-keys', '-t', sessionName, '-l', invocation);
      await sleep(300);
      await tmux('send-keys', '-t', sessionName, 'Enter');
    } else {
      await tmux('send-keys', '-t', sessionName, cmd, 'Enter');
    }
  } catch (err) {
    try { await tmux('kill-session', '-t', sessionName); } catch { /* best-effort */ }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch in tmux session "${sessionName}": ${msg}`, { cause: err });
  }
}

async function tmuxSendMessage(sessionName: string, message: string): Promise<void> {
  // Clear any partial input first
  await tmux('send-keys', '-t', sessionName, 'C-u');

  // For long or multiline messages, use load-buffer + paste-buffer to avoid
  // terminal buffer issues. Use randomUUID to prevent temp file collisions.
  if (message.includes('\n') || message.length > 200) {
    const bufferName = `devtask-${crypto.randomUUID()}`;
    const tmpPath = join(tmpdir(), `devtask-send-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpPath, message, { encoding: 'utf-8', mode: 0o600 });
    try {
      await tmux('load-buffer', '-b', bufferName, tmpPath);
      await tmux('paste-buffer', '-b', bufferName, '-t', sessionName, '-d');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      try { await tmux('delete-buffer', '-b', bufferName); } catch { /* may already be deleted by -d */ }
    }
  } else {
    // Use -l (literal) so text like "Enter" or "Space" isn't interpreted as tmux key names
    await tmux('send-keys', '-t', sessionName, '-l', message);
  }

  // Small delay before Enter so tmux fully processes the pasted text
  await sleep(300);
  await tmux('send-keys', '-t', sessionName, 'Enter');
}

async function tmuxIsAlive(sessionName: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', sessionName);
    return true;
  } catch {
    return false;
  }
}

// ─── Codex binary resolution (from ao packages/plugins/agent-codex) ───────────

export async function resolveCodexBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch { /* not found via which */ }

  const home = homedir();
  for (const candidate of [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    join(home, '.cargo', 'bin', 'codex'),
    join(home, '.npm', 'bin', 'codex'),
  ]) {
    try {
      await stat(candidate);
      return candidate;
    } catch { /* not at this location */ }
  }

  return 'codex';
}

function buildCodexLaunchCommand(binary: string, model?: string): string {
  const parts = [shellEscape(binary), '-c', 'check_for_update_on_startup=false', '--ask-for-approval', 'never'];
  if (model) parts.push('--model', shellEscape(model));
  return parts.join(' ');
}

// ─── JSONL scanning (from ao packages/plugins/agent-codex) ───────────────────

/**
 * Collect all JSONL files under a directory recursively. Codex stores sessions
 * in date-sharded directories: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Uses lstat (not stat) to avoid following symlinks that could create cycles.
 * Max depth capped at 4 (YYYY/MM/DD + 1 buffer) as an additional safety guard.
 */
async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith('.jsonl')) {
      results.push(fullPath);
    } else {
      try {
        const s = await lstat(fullPath);
        if (s.isDirectory()) results.push(...await collectJsonlFiles(fullPath, depth + 1));
      } catch { /* skip inaccessible entries */ }
    }
  }
  return results;
}

/**
 * Read the first maxLines complete JSONL records from a file without loading
 * the entire file. Uses a StringDecoder so multi-byte UTF-8 sequences that
 * straddle a chunk boundary are buffered correctly.
 */
async function readJsonlPrefixLines(filePath: string, maxLines: number): Promise<string[]> {
  const handle = await open(filePath, 'r');
  const lines: string[] = [];
  let partial = '';
  const decoder = new StringDecoder('utf8');

  try {
    while (lines.length < maxLines) {
      const buf = Buffer.allocUnsafe(SESSION_MATCH_SCAN_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) {
        partial += decoder.end();
        const finalLine = partial.trim();
        if (finalLine) lines.push(finalLine);
        break;
      }
      partial += decoder.write(buf.subarray(0, bytesRead));
      let nl = partial.indexOf('\n');
      while (nl !== -1 && lines.length < maxLines) {
        const line = partial.slice(0, nl).trim();
        if (line) lines.push(line);
        partial = partial.slice(nl + 1);
        nl = partial.indexOf('\n');
      }
    }
  } finally {
    await handle.close();
  }
  return lines;
}

function getPayload(entry: CodexJsonlLine): CodexJsonlPayload {
  return entry.payload ?? (entry as unknown as CodexJsonlPayload);
}

/**
 * Check if the first few JSONL records of a session file contain a session_meta
 * entry matching the given workspace path. Reads only the first N lines to avoid
 * loading potentially huge rollout files (100 MB+).
 */
async function sessionFileMatchesCwd(filePath: string, workspacePath: string): Promise<boolean> {
  try {
    const lines = await readJsonlPrefixLines(filePath, SESSION_MATCH_SCAN_LINE_LIMIT);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CodexJsonlLine;
        const payload = getPayload(entry);
        if (entry.type === 'session_meta' && payload.cwd === workspacePath) return true;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* unreadable file */ }
  return false;
}

/**
 * Find the most recently modified Codex session JSONL file whose session_meta
 * cwd matches the given workspace path. Scans ~/.codex/sessions/ recursively.
 */
async function findCodexSessionFile(workspacePath: string): Promise<string | null> {
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  let best: { path: string; mtime: number } | null = null;

  for (const f of files) {
    if (await sessionFileMatchesCwd(f, workspacePath)) {
      try {
        const s = await stat(f);
        if (!best || s.mtimeMs > best.mtime) best = { path: f, mtime: s.mtimeMs };
      } catch { /* skip if stat fails */ }
    }
  }
  return best?.path ?? null;
}

/** 30s TTL cache to avoid double scans within the same refresh cycle */
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

async function findSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) return cached.path;
  const result = await findCodexSessionFile(workspacePath);
  sessionFileCache.set(workspacePath, { path: result, expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS });
  return result;
}

function invalidateSessionFileCache(workspacePath: string): void {
  sessionFileCache.delete(workspacePath);
}

/**
 * Stream a JSONL file line-by-line to extract the Codex thread ID from the
 * session_meta entry. Uses readline to handle lines of arbitrary length (the
 * session_meta record can be 100KB+ due to embedded base_instructions).
 */
async function extractThreadId(filePath: string): Promise<string | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as CodexJsonlLine;
        const payload = getPayload(entry);
        if (entry.type === 'session_meta') {
          if (typeof payload.id === 'string' && payload.id) { rl.close(); return payload.id; }
          if (typeof payload.threadId === 'string' && payload.threadId) { rl.close(); return payload.threadId; }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* unreadable file */ }
  return null;
}

/**
 * Read new JSONL entries from the file starting at the given byte offset.
 * Handles partial lines at the end of the file (written mid-entry) by only
 * advancing the offset past fully-parsed records.
 */
async function readJsonlSince(
  filePath: string,
  offset: number,
): Promise<{ entries: CodexJsonlLine[]; newOffset: number }> {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    if (fileStat.size <= offset) return { entries: [], newOffset: offset };

    const toRead = fileStat.size - offset;
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, offset);

    const text = buffer.subarray(0, bytesRead).toString('utf-8');
    const rawLines = text.split('\n');
    const entries: CodexJsonlLine[] = [];
    let consumed = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const trimmed = line.trim();
      if (!trimmed) {
        // Advance past empty lines, but only if not the last (which may be partial)
        if (i < rawLines.length - 1) consumed += Buffer.byteLength(line, 'utf8') + 1;
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as CodexJsonlLine;
        entries.push(parsed);
        consumed += Buffer.byteLength(line, 'utf8') + 1;
      } catch {
        // Partial line at end of file — don't advance past it
        break;
      }
    }

    return { entries, newOffset: offset + consumed };
  } finally {
    await handle.close();
  }
}

// ─── CodexAgentRunner ─────────────────────────────────────────────────────────

export interface CodexAgentRunnerConfig {
  model?: string;
}

export class CodexAgentRunner implements AgentRunner {
  private readonly sessionStates = new Map<string, SessionState>();
  private resolvedBinary: string | null = null;
  private resolvingBinary: Promise<string> | null = null;

  constructor(private readonly config: CodexAgentRunnerConfig = {}) {}

  async start(workspacePath: string): Promise<SessionHandle> {
    const binary = await this.getResolvedBinary();
    const sessionName = `devtask-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    await tmuxCreateSession(sessionName, workspacePath, {
      CODEX_DISABLE_UPDATE_CHECK: '1',
    });

    const launchCommand = buildCodexLaunchCommand(binary, this.config.model);
    await tmuxSendLaunchCommand(sessionName, launchCommand);

    this.sessionStates.set(sessionName, { workspacePath, jsonlPath: null, jsonlOffset: 0 });

    return { id: sessionName, threadId: '' };
  }

  async *run(
    session: SessionHandle,
    prompt: string,
    opts?: RunOptions,
  ): AsyncIterable<RunEvent> {
    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS;
    const maxTurnMs = opts?.maxTurnMs ?? DEFAULT_MAX_TURN_MS;

    const state = this.sessionStates.get(session.id);
    if (!state) {
      yield { kind: 'failed', error: `Unknown session: ${session.id}` };
      return;
    }

    await tmuxSendMessage(session.id, prompt);

    const startedAt = Date.now();
    let lastActivityAt = Date.now();

    // Wait for the JSONL session file to appear. Codex writes it at startup with
    // session_meta (cwd, threadId). Invalidate cache so we don't return a stale
    // path from a previous run in the same workspace.
    if (!state.jsonlPath) {
      invalidateSessionFileCache(state.workspacePath);
      const waitStart = Date.now();
      while (!state.jsonlPath && Date.now() - waitStart < JSONL_WAIT_MAX_MS) {
        await sleep(JSONL_WAIT_POLL_MS);
        state.jsonlPath = await findSessionFileCached(state.workspacePath);
      }
    }

    if (!state.jsonlPath) {
      yield { kind: 'failed', error: 'Codex JSONL session file not found after 30s' };
      return;
    }

    // Extract threadId once per session (stored in handle for resume)
    if (!session.threadId) {
      const threadId = await extractThreadId(state.jsonlPath);
      if (threadId) session.threadId = threadId;
    }

    while (true) {
      await sleep(POLL_INTERVAL_MS);

      const now = Date.now();

      if (!(await tmuxIsAlive(session.id))) {
        yield { kind: 'failed', error: 'Agent tmux session died unexpectedly' };
        return;
      }

      if (now - startedAt > maxTurnMs) {
        yield { kind: 'stalled' };
        return;
      }

      // Read new JSONL entries and map to RunEvents
      let terminal = false;
      try {
        const { entries, newOffset } = await readJsonlSince(state.jsonlPath, state.jsonlOffset);
        state.jsonlOffset = newOffset;

        if (entries.length > 0) lastActivityAt = now;

        for (const entry of entries) {
          // Newer Codex versions wrap the semantic type in payload.type on event_msg
          // records. Prefer payloadType so approval_request / error surface correctly.
          const effectiveType = entry.payload?.type ?? entry.type;
          const payload = getPayload(entry);

          switch (effectiveType) {
            case 'task_complete':
              if (!session.threadId) {
                const threadId = await extractThreadId(state.jsonlPath);
                if (threadId) session.threadId = threadId;
              }
              yield { kind: 'completed' };
              return;

            case 'approval_request':
            case 'exec_approval_request':
            case 'apply_patch_approval_request':
              yield { kind: 'input_required', prompt: 'Approval required' };
              terminal = true;
              break;

            case 'error':
            case 'stream_error':
              yield { kind: 'failed', error: 'Codex reported an error' };
              terminal = true;
              break;

            case 'agent_message':
            case 'assistant_message':
              if (typeof payload.content === 'string' && payload.content) {
                yield { kind: 'output', text: payload.content };
              }
              break;

            case 'turn_complete':
            case 'turn_aborted':
              yield { kind: 'turn_complete' };
              break;
          }

          if (terminal) break;
        }
      } catch { /* transient read error — keep polling */ }

      if (terminal) return;

      if (now - lastActivityAt > stallMs) {
        yield { kind: 'stalled' };
        return;
      }
    }
  }

  async stop(session: SessionHandle): Promise<void> {
    this.sessionStates.delete(session.id);
    try {
      await tmux('kill-session', '-t', session.id);
    } catch { /* session may already be dead */ }
  }

  async sendInput(session: SessionHandle, message: string): Promise<void> {
    await tmuxSendMessage(session.id, message);
  }

  async getActivityState(session: SessionHandle): Promise<ActivityState> {
    const state = this.sessionStates.get(session.id);
    if (!state) return 'unknown';

    if (!(await tmuxIsAlive(session.id))) return 'unknown';

    const sessionFile = state.jsonlPath ?? await findSessionFileCached(state.workspacePath);
    if (!sessionFile) return 'unknown';

    try {
      const fileStat = await stat(sessionFile);
      const ageMs = Date.now() - fileStat.mtimeMs;

      const tailSize = 4096;
      const readFrom = Math.max(0, fileStat.size - tailSize);
      const handle = await open(sessionFile, 'r');
      const buf = Buffer.allocUnsafe(Math.min(tailSize, fileStat.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, readFrom);
      await handle.close();

      const tail = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);

      let lastType: string | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]!) as CodexJsonlLine;
          lastType = parsed.payload?.type ?? parsed.type ?? null;
          break;
        } catch { /* skip */ }
      }

      switch (lastType) {
        case 'approval_request':
        case 'exec_approval_request':
        case 'apply_patch_approval_request':
          return 'waiting_input';
        case 'error':
        case 'stream_error':
          return 'errored';
        default:
          return ageMs < 5_000 ? 'active' : 'idle';
      }
    } catch {
      return 'unknown';
    }
  }

  private async getResolvedBinary(): Promise<string> {
    if (this.resolvedBinary) return this.resolvedBinary;
    if (!this.resolvingBinary) this.resolvingBinary = resolveCodexBinary();
    try {
      this.resolvedBinary = await this.resolvingBinary;
    } finally {
      this.resolvingBinary = null;
    }
    return this.resolvedBinary;
  }
}
