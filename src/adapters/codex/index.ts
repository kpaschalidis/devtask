import crypto from "node:crypto";
import fs, { createReadStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentSessionRef } from "../../agent-session.js";
import type { ActivityState, AgentRunner, AgentStartOptions, RunEvent, RunOptions, SessionHandle } from "../../agent.js";
import { captureOutputAsync } from "../../infra/tmux.js";
import {
  buildCodexCommand,
  buildCodexCommandArgs,
  buildCodexInteractiveResumeCommand,
  buildCodexInteractiveStartCommand,
  buildCodexResumeCommand
} from "./command.js";

const execFileAsync = promisify(execFile);

const DEFAULT_STALL_MS = 120_000;
const DEFAULT_MAX_TURN_MS = 600_000;
const SESSION_MATCH_SCAN_CHUNK_BYTES = 8192;
const SESSION_MATCH_SCAN_LINE_LIMIT = 10;
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const MAX_SESSION_SCAN_DEPTH = 4;
const ACTIVE_WINDOW_MS = 5_000;
const ACTIVITY_POLL_MS = 250;
const DEFAULT_INTERACTIVE_MODEL = "gpt-5.5";

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

interface SessionState {
  workspacePath: string;
  codexHomePath: string;
  sessionsDir: string;
  startOptions: AgentStartOptions;
  startedAtMs: number;
  sessionFilePath: string | null;
}

export interface CodexAgentRunnerConfig {
  model?: string;
  sessionRoot?: string;
}

interface CodexSessionMeta {
  cwd: string | null;
  timestampMs: number | null;
}

interface SessionActivityState {
  lastActivityAtMs: number;
  lastSessionMtimeMs: number;
}

const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

export class CodexAgentRunner implements AgentRunner {
  private readonly sessionStates = new Map<string, SessionState>();
  private resolvedBinary: string | null = null;
  private resolvingBinary: Promise<string> | null = null;

  constructor(private readonly config: CodexAgentRunnerConfig = {}) {}

  buildStartCommand(options: AgentStartOptions): string {
    return buildCodexCommand({
      model: options.model ?? this.config.model ?? null,
      fullAuto: options.fullAuto,
      skipGitRepoCheck: options.skipGitRepoCheck,
      addDirs: options.addDirs
    });
  }

  buildResumeCommand(session: AgentSessionRef, options: { workspacePath: string; model?: string | null; prompt?: string | null }): string | null {
    const sessionId = session.resumeTarget ?? session.providerSessionId ?? session.conversationId;
    if (!sessionId) {
      return null;
    }

    return buildCodexResumeCommand(sessionId, {
      codexHome: session.storageRoot,
      model: options.model ?? this.config.model ?? null,
      prompt: options.prompt ?? null
    });
  }

  buildInteractiveResumeCommand(session: AgentSessionRef, options: { workspacePath: string; model?: string | null; prompt?: string | null }): string | null {
    const sessionId = session.resumeTarget ?? session.providerSessionId ?? session.conversationId;
    if (!sessionId) {
      return null;
    }

    return buildCodexInteractiveResumeCommand(sessionId, {
      codexHome: session.storageRoot,
      model: options.model ?? this.config.model ?? DEFAULT_INTERACTIVE_MODEL,
      prompt: options.prompt ?? null
    });
  }

  buildInteractiveStartCommand(options: AgentStartOptions, prompt: string): { command: string; session: AgentSessionRef } {
    const sessionName = `devtask-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const codexHomePath = prepareIsolatedCodexHome(options.env?.DEVTASK_TASK_DIR ?? null, sessionName, this.config.sessionRoot ?? null);
    const taskDir = options.env?.DEVTASK_TASK_DIR?.trim() ? [options.env.DEVTASK_TASK_DIR] : [];
    return {
      command: buildCodexInteractiveStartCommand(prompt, {
        codexHome: codexHomePath,
        model: options.model ?? this.config.model ?? DEFAULT_INTERACTIVE_MODEL,
        fullAuto: options.fullAuto,
        addDirs: [...taskDir, ...(options.addDirs ?? [])]
      }),
      session: {
        provider: "codex",
        transportId: null,
        providerSessionId: null,
        conversationId: null,
        resumeTarget: null,
        storageRoot: codexHomePath,
        transcriptPath: null,
        summary: null,
        summaryIsFallback: null
      }
    };
  }

  async hydrateSessionRef(session: AgentSessionRef, workspacePath: string): Promise<AgentSessionRef> {
    if (!session.storageRoot?.trim()) {
      return session;
    }

    const sessionsDir = join(session.storageRoot, "sessions");
    const transcriptPath = session.transcriptPath ?? await findSessionFileCached(sessionsDir, workspacePath);
    if (!transcriptPath) {
      return session;
    }

    const threadId = await extractThreadId(transcriptPath);
    const summary = await extractAssistantSummary(transcriptPath);
    return {
      ...session,
      transcriptPath,
      providerSessionId: session.providerSessionId ?? threadId,
      conversationId: session.conversationId ?? threadId,
      resumeTarget: session.resumeTarget ?? threadId,
      summary: summary ?? session.summary ?? (threadId ? "Codex session completed" : null),
      summaryIsFallback: summary ? false : session.summaryIsFallback ?? (threadId ? true : null)
    };
  }

  async inspectSessionActivity(session: AgentSessionRef, workspacePath: string): Promise<ActivityState> {
    if (session.transportId) {
      const output = await captureOutputAsync(session.transportId, 60);
      if (output.includes("Working (") || output.includes("esc to interrupt")) {
        return "active";
      }
      if (output.includes("Press enter to continue")) {
        return "waiting_input";
      }
      if (output.includes("\n› ")) {
        return "idle";
      }
    }

    const sessionsDir = session.storageRoot?.trim() ? join(session.storageRoot, "sessions") : null;
    if (!sessionsDir) {
      return "unknown";
    }

    const sessionFilePath = session.transcriptPath ?? await findSessionFileCached(sessionsDir, workspacePath);
    if (!sessionFilePath) {
      return "unknown";
    }

    try {
      const fileStat = await stat(sessionFilePath);
      const ageMs = Date.now() - fileStat.mtimeMs;
      const lines = await readJsonlTailLines(sessionFilePath, 20);
      let lastType: string | null = null;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]!) as CodexJsonlLine;
          lastType = parsed.payload?.type ?? parsed.type ?? null;
          break;
        } catch {
          continue;
        }
      }

      if (lastType === "approval_request" || lastType === "exec_approval_request" || lastType === "apply_patch_approval_request") {
        return "waiting_input";
      }
      if (lastType === "error" || lastType === "stream_error") {
        return "errored";
      }
      return ageMs < ACTIVE_WINDOW_MS ? "active" : "idle";
    } catch {
      return "unknown";
    }
  }

  async start(options: AgentStartOptions): Promise<SessionHandle> {
    const sessionName = `devtask-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const codexHomePath = prepareIsolatedCodexHome(options.env?.DEVTASK_TASK_DIR ?? null, sessionName, this.config.sessionRoot ?? null);

    this.sessionStates.set(sessionName, {
      workspacePath: options.workspacePath,
      codexHomePath,
      sessionsDir: join(codexHomePath, "sessions"),
      startOptions: options,
      startedAtMs: Date.now(),
      sessionFilePath: null
    });

    return {
      id: sessionName,
      provider: "codex",
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: codexHomePath,
      transcriptPath: null
    };
  }

  async *run(session: SessionHandle, prompt: string, opts?: RunOptions): AsyncIterable<RunEvent> {
    const state = this.sessionStates.get(session.id);
    if (!state) {
      yield { kind: "failed", error: `Unknown session: ${session.id}` };
      return;
    }

    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS;
    const maxTurnMs = opts?.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    const binary = await this.getResolvedBinary();
    const child = spawn(
      binary,
      buildCodexCommandArgs({
        model: state.startOptions.model ?? this.config.model ?? null,
        fullAuto: state.startOptions.fullAuto,
        skipGitRepoCheck: state.startOptions.skipGitRepoCheck,
        addDirs: state.startOptions.addDirs
      }),
      {
        cwd: state.workspacePath,
        env: {
          ...process.env,
          ...state.startOptions.env,
          HOME: dirname(state.codexHomePath),
          CODEX_HOME: state.codexHomePath,
          CODEX_DISABLE_UPDATE_CHECK: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    child.stdin.setDefaultEncoding("utf8");
    child.stdin.end(prompt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const stdoutQueue: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutEnded = false;
    let stderrEnded = false;
    let exitCode: number | null = null;
    let spawnErrorMessage: string | null = null;
    let stalled = false;
    const startedAtMs = Date.now();
    let activityState: SessionActivityState = {
      lastActivityAtMs: startedAtMs,
      lastSessionMtimeMs: 0
    };

    const killChild = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };

    const maxTimer = setTimeout(() => {
      stalled = true;
      killChild();
    }, maxTurnMs);

    child.stdout.on("data", (chunk: string) => {
      stdoutQueue.push(chunk);
      activityState = {
        ...activityState,
        lastActivityAtMs: Date.now()
      };
    });
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      activityState = {
        ...activityState,
        lastActivityAtMs: Date.now()
      };
    });
    child.stdout.on("end", () => {
      stdoutEnded = true;
    });
    child.stderr.on("end", () => {
      stderrEnded = true;
    });
    child.on("error", (error) => {
      spawnErrorMessage = error.message;
    });
    child.on("close", (code) => {
      exitCode = code;
    });

    while (spawnErrorMessage === null && (exitCode === null || stdoutQueue.length > 0 || !stdoutEnded || !stderrEnded)) {
      while (stdoutQueue.length > 0) {
        yield { kind: "output", text: stdoutQueue.shift()! };
      }
      if (exitCode !== null && stdoutQueue.length === 0 && stdoutEnded && stderrEnded) {
        break;
      }

      const sessionFilePath = state.sessionFilePath ?? await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
      if (sessionFilePath) {
        state.sessionFilePath = sessionFilePath;
        session.transcriptPath = sessionFilePath;
        try {
          const fileStat = await stat(sessionFilePath);
          activityState = updateSessionActivity(activityState, fileStat.mtimeMs, Date.now());
        } catch {
          // ignore stat races while the session file is being created or rotated
        }
      }

      const now = Date.now();
      if (now - startedAtMs > maxTurnMs) {
        stalled = true;
        killChild();
      } else if (now - activityState.lastActivityAtMs > stallMs) {
        stalled = true;
        killChild();
      }

      await sleep(ACTIVITY_POLL_MS);
    }

    clearTimeout(maxTimer);

    const sessionFilePath = await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
    state.sessionFilePath = sessionFilePath;
    session.transcriptPath = sessionFilePath;
    if (sessionFilePath) {
      const threadId = await extractThreadId(sessionFilePath);
      session.conversationId = threadId;
      session.providerSessionId = threadId;
      session.resumeTarget = threadId;
    }

    if (spawnErrorMessage) {
      yield { kind: "failed", error: spawnErrorMessage };
      return;
    }

    if (stalled) {
      yield { kind: "stalled" };
      return;
    }

    if (exitCode === 0) {
      yield { kind: "completed" };
      return;
    }

    const stderr = stderrChunks.join("").trim();
    yield { kind: "failed", error: stderr || `Codex exited with code ${exitCode ?? "unknown"}` };
  }

  async stop(session: SessionHandle): Promise<void> {
    this.sessionStates.delete(session.id);
  }

  async getActivityState(session: SessionHandle): Promise<ActivityState> {
    const state = this.sessionStates.get(session.id);
    if (!state) {
      return "unknown";
    }

    const sessionFilePath = state.sessionFilePath ?? await findSessionFileCached(state.sessionsDir, state.workspacePath, state.startedAtMs);
    if (!sessionFilePath) {
      return "unknown";
    }

    try {
      const fileStat = await stat(sessionFilePath);
      const ageMs = Date.now() - fileStat.mtimeMs;
      const lines = await readJsonlTailLines(sessionFilePath, 20);
      let lastType: string | null = null;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]!) as CodexJsonlLine;
          lastType = parsed.payload?.type ?? parsed.type ?? null;
          break;
        } catch {
          continue;
        }
      }

      if (lastType === "approval_request" || lastType === "exec_approval_request" || lastType === "apply_patch_approval_request") {
        return "waiting_input";
      }
      if (lastType === "error" || lastType === "stream_error") {
        return "errored";
      }
      return ageMs < ACTIVE_WINDOW_MS ? "active" : "idle";
    } catch {
      return "unknown";
    }
  }

  async getSessionInfo(session: SessionHandle): Promise<{ summary: string; summaryIsFallback: boolean } | null> {
    const state = this.sessionStates.get(session.id);
    const sessionFilePath = session.transcriptPath ?? state?.sessionFilePath ?? null;
    if (!sessionFilePath) {
      return null;
    }

    const summary = await extractAssistantSummary(sessionFilePath);
    if (!summary && !session.providerSessionId) {
      return null;
    }

    return {
      summary: summary ?? "Codex session completed",
      summaryIsFallback: summary === null
    };
  }

  private async getResolvedBinary(): Promise<string> {
    if (this.resolvedBinary) {
      return this.resolvedBinary;
    }
    if (!this.resolvingBinary) {
      this.resolvingBinary = resolveCodexBinary();
    }
    try {
      this.resolvedBinary = await this.resolvingBinary;
    } finally {
      this.resolvingBinary = null;
    }
    return this.resolvedBinary;
  }
}

export async function resolveCodexBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["codex"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) {
      return resolved;
    }
  } catch {
    // no-op
  }

  const home = homedir();
  for (const candidate of [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".cargo", "bin", "codex"),
    join(home, ".npm", "bin", "codex")
  ]) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return "codex";
}

function defaultCodexHome(explicitRoot?: string | null): string {
  if (explicitRoot?.trim()) {
    return explicitRoot;
  }
  return process.env.CODEX_HOME?.trim() ? process.env.CODEX_HOME : join(homedir(), ".codex");
}

function copyCodexHomeFileIfPresent(sourceHome: string, targetHome: string, relativePath: string): void {
  const source = join(sourceHome, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }

  const target = join(targetHome, relativePath);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function prepareIsolatedCodexHome(taskDir: string | null, sessionName: string, sourceRoot?: string | null): string {
  const sourceHome = defaultCodexHome(sourceRoot);
  const targetRoot = taskDir
    ? join(taskDir, "codex-sessions", sessionName)
    : join(tmpdir(), `devtask-codex-home-${sessionName}`);
  const targetHome = join(targetRoot, ".codex");

  fs.mkdirSync(targetHome, { recursive: true });
  copyCodexHomeFileIfPresent(sourceHome, targetHome, "auth.json");
  copyCodexHomeFileIfPresent(sourceHome, targetHome, "config.toml");
  copyCodexHomeFileIfPresent(sourceHome, targetHome, "version.json");
  fs.mkdirSync(join(targetHome, "sessions"), { recursive: true });
  fs.mkdirSync(join(targetHome, "logs"), { recursive: true });
  return targetHome;
}

export function prepareIsolatedCodexHomeForTest(taskDir: string | null, sessionName: string, sourceRoot?: string | null): string {
  return prepareIsolatedCodexHome(taskDir, sessionName, sourceRoot);
}

function buildSessionCacheKey(sessionsDir: string, workspacePath: string, startedAtMs?: number): string {
  return `${sessionsDir}::${workspacePath}::${startedAtMs ?? "none"}`;
}

async function findSessionFileCached(sessionsDir: string, workspacePath: string, startedAtMs?: number): Promise<string | null> {
  const cacheKey = buildSessionCacheKey(sessionsDir, workspacePath, startedAtMs);
  const cached = sessionFileCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }

  const path = await findCodexSessionFileInDir(sessionsDir, workspacePath, startedAtMs);
  if (path) {
    sessionFileCache.set(cacheKey, {
      path,
      expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS
    });
  } else {
    sessionFileCache.delete(cacheKey);
  }
  return path;
}

export function updateSessionActivity(
  current: SessionActivityState,
  sessionMtimeMs: number,
  now: number
): SessionActivityState {
  if (sessionMtimeMs <= current.lastSessionMtimeMs) {
    return current;
  }

  return {
    lastActivityAtMs: now,
    lastSessionMtimeMs: sessionMtimeMs
  };
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
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
  const handle = await open(filePath, "r");
  const lines: string[] = [];
  let partial = "";
  const decoder = new StringDecoder("utf8");

  try {
    while (lines.length < maxLines) {
      const buffer = Buffer.allocUnsafe(SESSION_MATCH_SCAN_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        partial += decoder.end();
        const finalLine = partial.trim();
        if (finalLine) {
          lines.push(finalLine);
        }
        break;
      }

      partial += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = partial.indexOf("\n");
      while (newlineIndex !== -1 && lines.length < maxLines) {
        const line = partial.slice(0, newlineIndex).trim();
        if (line) {
          lines.push(line);
        }
        partial = partial.slice(newlineIndex + 1);
        newlineIndex = partial.indexOf("\n");
      }
    }
  } finally {
    await handle.close();
  }

  return lines;
}

async function readJsonlTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function getPayload(entry: CodexJsonlLine): CodexJsonlPayload {
  return entry.payload ?? (entry as unknown as CodexJsonlPayload);
}

async function readSessionMeta(filePath: string): Promise<CodexSessionMeta | null> {
  try {
    const lines = await readJsonlPrefixLines(filePath, SESSION_MATCH_SCAN_LINE_LIMIT);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CodexJsonlLine;
        if (entry.type !== "session_meta") {
          continue;
        }
        const payload = getPayload(entry);
        const timestampValue = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
        return {
          cwd: typeof payload.cwd === "string" ? payload.cwd : null,
          timestampMs: Number.isFinite(timestampValue) ? timestampValue : null
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
    if (!meta || meta.cwd !== workspacePath) {
      continue;
    }

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
      if (!meta || meta.cwd !== workspacePath) {
        continue;
      }
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

export async function findCodexSessionFileInDirForTest(
  sessionsDir: string,
  workspacePath: string,
  startedAtMs?: number
): Promise<string | null> {
  return findCodexSessionFileInDir(sessionsDir, workspacePath, startedAtMs);
}

async function extractThreadId(filePath: string): Promise<string | null> {
  try {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const entry = JSON.parse(trimmed) as CodexJsonlLine;
        if (entry.type !== "session_meta") {
          continue;
        }
        const payload = getPayload(entry);
        if (typeof payload.id === "string" && payload.id) {
          reader.close();
          return payload.id;
        }
        if (typeof payload.threadId === "string" && payload.threadId) {
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
  if ((entry.type === "response_item" || entry.payload?.type === "message") && payload.role === "assistant") {
    const contentItems = Array.isArray(payload.content)
      ? payload.content
      : Array.isArray(payload.content_items)
        ? payload.content_items
        : Array.isArray(payload.contentParts)
          ? payload.contentParts
          : [];

    const text = contentItems
      .filter((item) => item?.type === "output_text" && typeof item.text === "string" && item.text)
      .map((item) => item.text!)
      .join("");

    if (text) {
      return text;
    }
  }

  if (typeof payload.content === "string" && payload.content) {
    return payload.content;
  }

  return null;
}

async function extractAssistantSummary(filePath: string): Promise<string | null> {
  try {
    const lines = await readJsonlTailLines(filePath, 200);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]!) as CodexJsonlLine;
        const payload = getPayload(entry);
        const text = extractAssistantText(entry, payload)?.trim();
        if (text) {
          return text;
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
