import crypto from 'node:crypto';
import fs, { createReadStream } from 'node:fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ActivityState, Agent, AgentCreateSessionInput, AgentSessionInfo, RunEvent, RunOptions } from '../../agent/agent.js';
import type { PreparedSessionInstructions } from '../../instructions/instruction-payload.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { RuntimeHandle } from '../../runtime/runtime.js';

const execFileAsync = promisify(execFile);

const DEFAULT_STALL_MS = 120_000;
const DEFAULT_MAX_TURN_MS = 600_000;
const SESSION_MATCH_SCAN_CHUNK_BYTES = 8192;
const SESSION_MATCH_SCAN_LINE_LIMIT = 10;
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const MAX_SESSION_SCAN_DEPTH = 4;
const ACTIVE_WINDOW_MS = 5_000;
const ACTIVITY_POLL_MS = 250;

interface CodexJsonlPayload {
  id?: string;
  cwd?: string;
  threadId?: string;
  timestamp?: string;
  type?: string;
  role?: string;
  content_items?: Array<{ type?: string; text?: string }>;
  contentParts?: Array<{ type?: string; text?: string }>;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface CodexJsonlLine {
  type?: string;
  payload?: CodexJsonlPayload;
}

interface SessionActivityState {
  lastActivityAtMs: number;
  lastSessionMtimeMs: number;
}

interface ExecSessionState {
  workspacePath: string;
  codexHomePath: string;
  sessionsDir: string;
  startedAtMs: number;
  sessionFilePath: string | null;
  child: ChildProcessWithoutNullStreams | null;
  stdoutQueue: string[];
  stderrChunks: string[];
  stdoutEnded: boolean;
  stderrEnded: boolean;
  exitCode: number | null;
  spawnErrorMessage: string | null;
  stalled: boolean;
  activityState: SessionActivityState;
  promptSent: boolean;
  stopTimer: NodeJS.Timeout | null;
}

export interface CodexExecAgentConfig {
  model?: string;
  sessionRoot?: string;
  fullAuto?: boolean;
  skipGitRepoCheck?: boolean;
  addDirs?: readonly string[];
  binaryPathResolver?: () => Promise<string>;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

export class CodexExecAgent implements Agent {
  readonly name = 'codex';
  readonly promptDelivery = 'post-launch' as const;

  private readonly sessionStates = new Map<string, ExecSessionState>();
  private resolvedBinary: string | null = null;
  private resolvingBinary: Promise<string> | null = null;

  constructor(private readonly config: CodexExecAgentConfig = {}) {}

  async getLaunchCommand(_workspacePath: string, _instructions?: PreparedSessionInstructions): Promise<string> {
    return 'true';
  }

  getEnvironment(_workspacePath: string): Record<string, string> {
    return { CODEX_DISABLE_UPDATE_CHECK: '1' };
  }

  async createSession(input: AgentCreateSessionInput): Promise<RuntimeHandle> {
    const taskDir = typeof input.environment['DEVTASK_TASK_DIR'] === 'string' ? input.environment['DEVTASK_TASK_DIR'] : null;
    const codexHomePath = prepareIsolatedCodexHome(taskDir, input.sessionId, this.config.sessionRoot ?? null);
    const handle: RuntimeHandle = {
      id: input.sessionId,
      runtimeName: 'codex-exec',
      data: {
        workspacePath: input.workspacePath,
      },
    };

    this.sessionStates.set(handle.id, {
      workspacePath: input.workspacePath,
      codexHomePath,
      sessionsDir: join(codexHomePath, 'sessions'),
      startedAtMs: Date.now(),
      sessionFilePath: null,
      child: null,
      stdoutQueue: [],
      stderrChunks: [],
      stdoutEnded: false,
      stderrEnded: false,
      exitCode: null,
      spawnErrorMessage: null,
      stalled: false,
      activityState: {
        lastActivityAtMs: Date.now(),
        lastSessionMtimeMs: 0,
      },
      promptSent: false,
      stopTimer: null,
    });

    handle.data['codexHome'] = codexHomePath;
    return handle;
  }

  async sendMessage(handle: RuntimeHandle, _runtime: Runtime, taskInput: string): Promise<void> {
    const state = this.sessionStates.get(handle.id);
    if (!state) throw new Error(`Unknown codex exec session: ${handle.id}`);
    if (state.promptSent) throw new Error(`Codex exec session already started: ${handle.id}`);

    const binary = await this.getResolvedBinary();
    const child = (this.config.spawnProcess ?? spawn)(
      binary,
      buildCodexExecArgs({
        model: this.config.model ?? null,
        fullAuto: this.config.fullAuto,
        skipGitRepoCheck: this.config.skipGitRepoCheck,
        addDirs: this.config.addDirs,
      }),
      {
        cwd: state.workspacePath,
        env: {
          ...process.env,
          HOME: dirname(state.codexHomePath),
          CODEX_HOME: state.codexHomePath,
          CODEX_DISABLE_UPDATE_CHECK: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.end(taskInput);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      state.stdoutQueue.push(chunk);
      state.activityState = { ...state.activityState, lastActivityAtMs: Date.now() };
    });
    child.stderr.on('data', (chunk: string) => {
      state.stderrChunks.push(chunk);
      state.activityState = { ...state.activityState, lastActivityAtMs: Date.now() };
    });
    child.stdout.on('end', () => {
      state.stdoutEnded = true;
    });
    child.stderr.on('end', () => {
      state.stderrEnded = true;
    });
    child.on('error', (error) => {
      state.spawnErrorMessage = error.message;
    });
    child.on('close', (code) => {
      state.exitCode = code;
    });

    state.child = child;
    state.promptSent = true;
  }

  async *readEvents(handle: RuntimeHandle, _runtime: Runtime, opts?: RunOptions): AsyncIterable<RunEvent> {
    const state = this.sessionStates.get(handle.id);
    if (!state) {
      yield { kind: 'failed', error: `Unknown codex exec session: ${handle.id}` };
      return;
    }
    if (!state.promptSent) {
      yield { kind: 'failed', error: 'Codex exec session has not started' };
      return;
    }

    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS;
    const maxTurnMs = opts?.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    state.stopTimer = setTimeout(() => {
      state.stalled = true;
      state.child?.kill('SIGTERM');
    }, maxTurnMs);

    while (state.spawnErrorMessage === null && (state.exitCode === null || state.stdoutQueue.length > 0 || !state.stdoutEnded || !state.stderrEnded)) {
      while (state.stdoutQueue.length > 0) {
        yield { kind: 'output', text: state.stdoutQueue.shift()! };
      }
      if (state.exitCode !== null && state.stdoutQueue.length === 0 && state.stdoutEnded && state.stderrEnded) {
        break;
      }

      const sessionFilePath = state.sessionFilePath ?? await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
      if (sessionFilePath) {
        state.sessionFilePath = sessionFilePath;
        handle.data['transcriptPath'] = sessionFilePath;
        try {
          const fileStat = await stat(sessionFilePath);
          state.activityState = updateSessionActivity(state.activityState, fileStat.mtimeMs, Date.now());
        } catch {
          // ignore stat races while the file is being written
        }
      }

      if (Date.now() - state.activityState.lastActivityAtMs > stallMs) {
        state.stalled = true;
        state.child?.kill('SIGTERM');
      }

      await sleep(ACTIVITY_POLL_MS);
    }

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }

    const sessionFilePath = await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
    state.sessionFilePath = sessionFilePath;
    handle.data['transcriptPath'] = sessionFilePath;
    if (sessionFilePath) {
      const threadId = await extractThreadId(sessionFilePath);
      if (threadId) {
        handle.data['threadId'] = threadId;
      }
    }

    if (state.spawnErrorMessage) {
      yield { kind: 'failed', error: state.spawnErrorMessage };
      return;
    }
    if (state.stalled) {
      yield { kind: 'stalled' };
      return;
    }
    if (state.exitCode === 0) {
      yield { kind: 'completed' };
      return;
    }

    yield {
      kind: 'failed',
      error: state.stderrChunks.join('').trim() || `Codex exited with code ${state.exitCode ?? 'unknown'}`,
    };
  }

  release(handle: RuntimeHandle): void {
    const state = this.sessionStates.get(handle.id);
    if (!state) return;
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }
    if (state.child && state.exitCode === null) {
      state.child.kill('SIGTERM');
    }
    this.sessionStates.delete(handle.id);
  }

  async getActivityState(handle: RuntimeHandle, _runtime: Runtime): Promise<ActivityState> {
    const state = this.sessionStates.get(handle.id);
    if (!state) return 'unknown';

    const sessionFilePath = state.sessionFilePath ?? await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
    if (!sessionFilePath) {
      return state.exitCode === null ? 'active' : 'unknown';
    }

    try {
      const fileStat = await stat(sessionFilePath);
      const ageMs = Date.now() - fileStat.mtimeMs;
      return ageMs < ACTIVE_WINDOW_MS ? 'active' : 'idle';
    } catch {
      return 'unknown';
    }
  }

  async getSessionInfo(handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    const state = this.sessionStates.get(handle.id);
    const transcriptPath = typeof handle.data['transcriptPath'] === 'string'
      ? handle.data['transcriptPath']
      : state?.sessionFilePath ?? null;
    if (!transcriptPath) {
      return null;
    }

    const summary = await extractAssistantSummary(transcriptPath);
    const threadId = typeof handle.data['threadId'] === 'string' ? handle.data['threadId'] : await extractThreadId(transcriptPath);
    if (threadId) {
      handle.data['threadId'] = threadId;
    }

    if (!summary && !threadId) {
      return null;
    }

    return {
      summary: summary ?? 'Codex session completed',
      summaryIsFallback: summary === null,
      agentSessionId: threadId ?? handle.id,
      metadata: {
        ...(threadId ? { threadId } : {}),
        transcriptPath,
      },
    };
  }

  private async getResolvedBinary(): Promise<string> {
    if (this.resolvedBinary) return this.resolvedBinary;
    if (!this.resolvingBinary) {
      this.resolvingBinary = (this.config.binaryPathResolver ?? resolveCodexBinary)();
    }
    try {
      this.resolvedBinary = await this.resolvingBinary;
    } finally {
      this.resolvingBinary = null;
    }
    return this.resolvedBinary;
  }
}

export function buildCodexExecArgs(
  options: { model?: string | null; fullAuto?: boolean; skipGitRepoCheck?: boolean; addDirs?: readonly string[] } = {},
): string[] {
  const args = ['exec'];
  if (options.fullAuto !== false) {
    args.push('--full-auto');
  }
  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  args.push('--add-dir', '$DEVTASK_TASK_DIR');
  for (const dir of options.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (options.model) {
    args.push('-m', options.model);
  }
  args.push('-');
  return args;
}

async function resolveCodexBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // no-op
  }

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
    } catch {
      continue;
    }
  }

  return 'codex';
}

function defaultCodexHome(explicitRoot?: string | null): string {
  if (explicitRoot?.trim()) return explicitRoot;
  return process.env.CODEX_HOME?.trim() ? process.env.CODEX_HOME : join(homedir(), '.codex');
}

function copyCodexHomeFileIfPresent(sourceHome: string, targetHome: string, relativePath: string): void {
  const source = join(sourceHome, relativePath);
  if (!fs.existsSync(source)) return;
  const target = join(targetHome, relativePath);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function prepareIsolatedCodexHome(taskDir: string | null, sessionName: string, sourceRoot?: string | null): string {
  const sourceHome = defaultCodexHome(sourceRoot);
  const targetRoot = taskDir
    ? join(taskDir, 'codex-sessions', sessionName)
    : join(tmpdir(), `devtask-codex-home-${sessionName}`);
  const targetHome = join(targetRoot, '.codex');

  fs.mkdirSync(targetHome, { recursive: true });
  copyCodexHomeFileIfPresent(sourceHome, targetHome, 'auth.json');
  copyCodexHomeFileIfPresent(sourceHome, targetHome, 'config.toml');
  copyCodexHomeFileIfPresent(sourceHome, targetHome, 'version.json');
  fs.mkdirSync(join(targetHome, 'sessions'), { recursive: true });
  fs.mkdirSync(join(targetHome, 'logs'), { recursive: true });
  return targetHome;
}

function buildSessionCacheKey(sessionsDir: string, workspacePath: string, startedAtMs?: number): string {
  return `${sessionsDir}::${workspacePath}::${startedAtMs ?? 'none'}`;
}

export async function findSessionFileCached(sessionsDir: string, workspacePath: string, startedAtMs?: number): Promise<string | null> {
  const cacheKey = buildSessionCacheKey(sessionsDir, workspacePath, startedAtMs);
  const cached = sessionFileCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }
  const found = await findCodexSessionFileInDir(sessionsDir, workspacePath, startedAtMs);
  if (found) {
    sessionFileCache.set(cacheKey, { path: found, expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS });
  } else {
    sessionFileCache.delete(cacheKey);
  }
  return found;
}

export function updateSessionActivity(
  current: SessionActivityState,
  sessionMtimeMs: number,
  now: number,
): SessionActivityState {
  if (sessionMtimeMs <= current.lastSessionMtimeMs) {
    return current;
  }
  return {
    lastActivityAtMs: now,
    lastSessionMtimeMs: sessionMtimeMs,
  };
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith('.jsonl')) {
      files.push(fullPath);
      continue;
    }
    try {
      const entryStat = await lstat(fullPath);
      if (entryStat.isDirectory()) {
        files.push(...await collectJsonlFiles(fullPath, depth + 1));
      }
    } catch {
      continue;
    }
  }
  return files;
}

async function readJsonlPrefixLines(filePath: string, maxLines: number): Promise<string[]> {
  const handle = await open(filePath, 'r');
  const lines: string[] = [];
  let partial = '';
  const decoder = new StringDecoder('utf8');
  try {
    while (lines.length < maxLines) {
      const buffer = Buffer.allocUnsafe(SESSION_MATCH_SCAN_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        partial += decoder.end();
        const finalLine = partial.trim();
        if (finalLine) lines.push(finalLine);
        break;
      }
      partial += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = partial.indexOf('\n');
      while (newlineIndex !== -1 && lines.length < maxLines) {
        const line = partial.slice(0, newlineIndex).trim();
        if (line) lines.push(line);
        partial = partial.slice(newlineIndex + 1);
        newlineIndex = partial.indexOf('\n');
      }
    }
  } finally {
    await handle.close();
  }
  return lines;
}

async function readJsonlTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, 'utf8');
  return content.split('\n').map((line) => line.trim()).filter(Boolean).slice(-maxLines);
}

function getPayload(entry: CodexJsonlLine): CodexJsonlPayload {
  return entry.payload ?? (entry as unknown as CodexJsonlPayload);
}

async function readSessionMeta(filePath: string): Promise<{ cwd: string | null; timestampMs: number | null } | null> {
  try {
    const lines = await readJsonlPrefixLines(filePath, SESSION_MATCH_SCAN_LINE_LIMIT);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CodexJsonlLine;
        if (entry.type !== 'session_meta') continue;
        const payload = getPayload(entry);
        const timestampValue = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : Number.NaN;
        return {
          cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
          timestampMs: Number.isFinite(timestampValue) ? timestampValue : null,
        };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function findCodexSessionFileInDir(sessionsDir: string, workspacePath: string, startedAtMs?: number): Promise<string | null> {
  const files = await collectJsonlFiles(sessionsDir);
  let best: { path: string; score: number; mtime: number } | null = null;

  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    if (!meta || meta.cwd !== workspacePath) continue;
    try {
      const fileStat = await stat(filePath);
      const score =
        startedAtMs !== undefined && meta.timestampMs !== null
          ? Math.abs(meta.timestampMs - startedAtMs)
          : Number.MAX_SAFE_INTEGER - fileStat.mtimeMs;
      if (!best || score < best.score || (score === best.score && fileStat.mtimeMs > best.mtime)) {
        best = { path: filePath, score, mtime: fileStat.mtimeMs };
      }
    } catch {
      continue;
    }
  }

  if (startedAtMs !== undefined && best && best.score > 60_000) {
    let latest: { path: string; mtime: number } | null = null;
    for (const filePath of files) {
      const meta = await readSessionMeta(filePath);
      if (!meta || meta.cwd !== workspacePath) continue;
      try {
        const fileStat = await stat(filePath);
        if (!latest || fileStat.mtimeMs > latest.mtime) {
          latest = { path: filePath, mtime: fileStat.mtimeMs };
        }
      } catch {
        continue;
      }
    }
    return latest?.path ?? best.path;
  }

  return best?.path ?? null;
}

export async function extractThreadId(filePath: string): Promise<string | null> {
  try {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as CodexJsonlLine;
        if (entry.type !== 'session_meta') continue;
        const payload = getPayload(entry);
        if (typeof payload.id === 'string' && payload.id) {
          reader.close();
          return payload.id;
        }
        if (typeof payload.threadId === 'string' && payload.threadId) {
          reader.close();
          return payload.threadId;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractAssistantText(entry: CodexJsonlLine, payload: CodexJsonlPayload): string | null {
  if ((entry.type === 'response_item' || entry.payload?.type === 'message') && payload.role === 'assistant') {
    const contentItems = Array.isArray(payload.content)
      ? payload.content
      : Array.isArray(payload.content_items)
        ? payload.content_items
        : Array.isArray(payload.contentParts)
          ? payload.contentParts
          : [];

    const text = contentItems
      .filter((item) => item?.type === 'output_text' && typeof item.text === 'string' && item.text)
      .map((item) => item.text!)
      .join('');

    if (text) return text;
  }

  if (typeof payload.content === 'string' && payload.content) {
    return payload.content;
  }
  return null;
}

export async function extractAssistantSummary(filePath: string): Promise<string | null> {
  try {
    const lines = await readJsonlTailLines(filePath, 200);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]!) as CodexJsonlLine;
        const payload = getPayload(entry);
        const text = extractAssistantText(entry, payload)?.trim();
        if (text) return text;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function configureManagedHooks(codexHomePath: string | null, command: string | null): void {
  if (!codexHomePath?.trim()) {
    return;
  }

  const hooksPath = join(codexHomePath, 'hooks.json');
  const completionScriptPath = join(codexHomePath, 'completion-cmd.sh');

  if (!command?.trim()) {
    for (const targetPath of [hooksPath, completionScriptPath]) {
      try {
        fs.unlinkSync(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return;
  }

  fs.mkdirSync(codexHomePath, { recursive: true });
  fs.writeFileSync(completionScriptPath, `#!/bin/bash\nset -e\n${command}\n`);
  fs.chmodSync(completionScriptPath, 0o755);

  const stopScriptPath = ensureGlobalStopScript();
  fs.writeFileSync(
    hooksPath,
    `${JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `bash ${stopScriptPath}`,
                timeout: 30,
                statusMessage: 'Finalizing devtask phase run',
              },
            ],
          },
        ],
      },
    }, null, 2)}\n`,
  );
}

function ensureGlobalStopScript(): string {
  const hooksDir = join(homedir(), '.devtask', 'hooks');
  const scriptPath = join(hooksDir, 'stop.sh');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      '#!/bin/bash',
      'set -e',
      'script="${CODEX_HOME}/completion-cmd.sh"',
      'if [ -f "$script" ]; then',
      '  exec bash "$script"',
      'fi',
    ].join('\n') + '\n',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}
