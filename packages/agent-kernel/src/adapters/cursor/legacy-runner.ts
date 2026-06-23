import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { ActivityState, RunEvent, RunOptions } from "../../agent/agent.js";
import {
  captureTmuxOutput,
  createBareTmuxSession,
  getTmuxForegroundCommand,
  isTmuxSessionAlive,
  killTmuxSession,
  sendTmuxLaunchCommand,
  sendTmuxMessage,
  writeTmuxLaunchScript,
} from "../tmux/index.js";
import { buildCursorCommand } from "./command.js";

const execFileAsync = promisify(execFile);

const CURSOR_DIR_NAME = ".cursor";
const CURSOR_CHAT_FILE = "chat.md";
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALL_MS = 120_000;
const DEFAULT_MAX_TURN_MS = 600_000;
const READY_TIMEOUT_MS = 20_000;
const READY_STABLE_POLLS = 2;
const OUTPUT_LINES = 200;
const SUMMARY_MAX_LENGTH = 120;
const RECENT_COMMIT_WINDOW_SECONDS = 60;
const ACTIVE_WINDOW_MS = 5_000;

interface CursorSessionState {
  workspacePath: string;
  lastOutput: string;
}

export interface AgentSessionRef {
  provider: "cursor";
  transportId: string | null;
  resumeContext: Record<string, string | null>;
  summary: string | null;
  summaryIsFallback: boolean | null;
}

export interface SessionHandle {
  id: string;
  provider: "cursor";
  providerSessionId?: string | null;
  conversationId?: string | null;
  resumeTarget?: string | null;
  storageRoot?: string | null;
  transcriptPath?: string | null;
}

export interface AgentStartOptions {
  workspacePath: string;
  model?: string | null;
  fullAuto?: boolean;
  skipGitRepoCheck?: boolean;
  addDirs?: readonly string[];
  env?: Record<string, string>;
  managedCompletionCommand?: string | null;
}

export interface AgentRunner {
  start(options: AgentStartOptions): Promise<SessionHandle>;
  run(session: SessionHandle, prompt: string, options?: RunOptions): AsyncIterable<RunEvent>;
  sendInput?(session: SessionHandle, message: string): Promise<void>;
  getActivityState?(session: SessionHandle): Promise<ActivityState>;
  getSessionInfo?(session: SessionHandle): Promise<{ summary: string; summaryIsFallback: boolean } | null>;
  stop?(session: SessionHandle): Promise<void>;
  buildStartCommand?(options: AgentStartOptions): string;
  buildInteractiveStartCommand?(options: AgentStartOptions, prompt: string): { command: string; session: AgentSessionRef };
}

export interface CursorAgentRunnerConfig {
  model?: string;
}

export class CursorAgentRunner implements AgentRunner {
  private readonly sessionStates = new Map<string, CursorSessionState>();

  constructor(private readonly config: CursorAgentRunnerConfig = {}) {}

  buildStartCommand(options: AgentStartOptions): string {
    return buildCursorCommand({
      model: options.model ?? this.config.model ?? null,
      fullAuto: options.fullAuto
    });
  }

  buildInteractiveStartCommand(options: AgentStartOptions, _prompt: string): { command: string; session: AgentSessionRef } {
    return {
      command: buildCursorLaunchCommand(options, this.config.model),
      session: emptyCursorSessionRef()
    };
  }

  async start(options: AgentStartOptions): Promise<SessionHandle> {
    const sessionName = `devtask-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    createBareTmuxSession(sessionName, options.workspacePath);

    const envLines = Object.entries({
      ...options.env,
      PATH: process.env["PATH"] ?? ""
    })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
      .join("\n");

    const launchCommand = buildCursorLaunchCommand(options, this.config.model);
    const scriptPath = writeTmuxLaunchScript(`${buildAgentEnvResetCommand()}\n${envLines}\n${launchCommand}`, "devtask");
    sendTmuxLaunchCommand(sessionName, `bash ${shellEscape(scriptPath)}`);

    const ready = await waitForCursorReady(sessionName);
    if (!ready) {
      killTmuxSession(sessionName);
      throw new Error("Cursor agent did not become ready in time");
    }

    const initialOutput = await captureTmuxOutput(sessionName, OUTPUT_LINES);
    this.sessionStates.set(sessionName, {
      workspacePath: options.workspacePath,
      lastOutput: initialOutput
    });

    return {
      id: sessionName,
      provider: "cursor",
      providerSessionId: null,
      conversationId: null,
      resumeTarget: null,
      storageRoot: null,
      transcriptPath: null
    };
  }

  async *run(session: SessionHandle, prompt: string, opts?: RunOptions): AsyncIterable<RunEvent> {
    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS;
    const maxTurnMs = opts?.maxTurnMs ?? DEFAULT_MAX_TURN_MS;

    const state = this.sessionStates.get(session.id);
    if (!state) {
      yield { kind: "failed", error: `Unknown session: ${session.id}` };
      return;
    }

    await sendTmuxMessage(session.id, prompt);

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let sawActiveTurn = false;
    let idleStablePolls = 0;

    while (true) {
      await sleep(POLL_INTERVAL_MS);

      const now = Date.now();
      if (!(await isTmuxSessionAlive(session.id))) {
        yield { kind: "failed", error: "Agent tmux session died unexpectedly" };
        return;
      }

      if (now - startedAt > maxTurnMs) {
        yield { kind: "stalled" };
        return;
      }

      const output = await captureTmuxOutput(session.id, OUTPUT_LINES);
      const delta = diffOutput(state.lastOutput, output);
      if (delta) {
        state.lastOutput = output;
        lastActivityAt = now;
        idleStablePolls = 0;
        yield { kind: "output", text: delta };
      }

      const activity = detectActivity(output);
      if (activity === "waiting_input") {
        yield { kind: "input_required", prompt: "Approval required in Cursor" };
        return;
      }

      if (activity === "active") {
        sawActiveTurn = true;
        idleStablePolls = 0;
      } else if (activity === "idle" && sawActiveTurn) {
        idleStablePolls += 1;
        if (idleStablePolls >= READY_STABLE_POLLS) {
          yield { kind: "completed" };
          return;
        }
      } else {
        idleStablePolls = 0;
      }

      if (delta.length === 0) {
        const hasSideEffects = await hasRecentActivitySignal(state.workspacePath);
        if (hasSideEffects) {
          lastActivityAt = now;
        }
      }

      if (now - lastActivityAt > stallMs) {
        yield { kind: "stalled" };
        return;
      }
    }
  }

  async sendInput(session: SessionHandle, message: string): Promise<void> {
    await sendTmuxMessage(session.id, message);
  }

  async stop(session: SessionHandle): Promise<void> {
    this.sessionStates.delete(session.id);
    killTmuxSession(session.id);
  }

  async getActivityState(session: SessionHandle): Promise<ActivityState> {
    const state = this.sessionStates.get(session.id);
    if (!state) {
      return "unknown";
    }

    if (!(await isTmuxSessionAlive(session.id))) {
      return "unknown";
    }

    const output = await captureTmuxOutput(session.id, OUTPUT_LINES);
    const activity = detectActivity(output);
    if (activity !== "idle") {
      return activity;
    }

    return (await hasRecentActivitySignal(state.workspacePath)) ? "active" : "idle";
  }

  async getSessionInfo(session: SessionHandle): Promise<{ summary: string; summaryIsFallback: boolean } | null> {
    const state = this.sessionStates.get(session.id);
    if (!state) {
      return null;
    }

    const summary = await extractCursorSummary(state.workspacePath);
    if (!summary) {
      return null;
    }

    return {
      summary,
      summaryIsFallback: true
    };
  }

}

function buildCursorLaunchCommand(options: AgentStartOptions, fallbackModel?: string): string {
  const parts = ["agent"];
  if (options.fullAuto !== false) {
    parts.push("--force", "--sandbox", "disabled", "--approve-mcps");
  }
  const model = options.model ?? fallbackModel ?? null;
  if (model) {
    parts.push("--model", shellEscape(model));
  }
  return parts.join(" ");
}

function emptyCursorSessionRef(): AgentSessionRef {
  return {
    provider: "cursor",
    transportId: null,
    resumeContext: {},
    summary: null,
    summaryIsFallback: null
  };
}


function buildAgentEnvResetCommand(): string {
  return "unset CODEX_THREAD_ID CODEX_INTERNAL_ORIGINATOR_OVERRIDE CODEX_CI CODEX_SHELL";
}

async function waitForCursorReady(sessionName: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let stableCount = 0;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const [alive, foreground, output] = await Promise.all([
      isTmuxSessionAlive(sessionName),
      getTmuxForegroundCommand(sessionName),
      captureTmuxOutput(sessionName, 20)
    ]);

    if (!alive) {
      return false;
    }

    if (detectActivity(output) === "waiting_input") {
      return false;
    }

    const isAgentForeground = foreground === "agent" || foreground === "node";
    if (!isAgentForeground) {
      stableCount = 0;
      lastOutput = "";
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (detectActivity(output) === "idle") {
      if (output === lastOutput) {
        stableCount += 1;
      } else {
        stableCount = 1;
        lastOutput = output;
      }

      if (stableCount >= READY_STABLE_POLLS) {
        return true;
      }
    } else {
      stableCount = 0;
      lastOutput = output;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

function detectActivity(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) {
    return "idle";
  }

  const lines = terminalOutput.trim().split("\n");
  const tail = lines.slice(-5).join("\n");
  const lastLine = lines.at(-1)?.trim() ?? "";

  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/Approve.*changes\?/i.test(tail)) return "waiting_input";
  if (/Continue\?/i.test(tail)) return "waiting_input";
  if (/\[Yes\].*\[No\]/i.test(tail)) return "waiting_input";
  if (/proceed\?/i.test(tail)) return "waiting_input";
  if (/Press Enter to continue/i.test(tail)) return "waiting_input";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (/^agent>\s*$/.test(lastLine)) return "idle";
  if (/^\[agent\]\s*$/.test(lastLine)) return "idle";

  return "active";
}

function diffOutput(previous: string, current: string): string {
  if (!previous) {
    return current;
  }
  if (current === previous) {
    return "";
  }
  if (current.startsWith(previous)) {
    return current.slice(previous.length);
  }

  let sharedPrefixLength = 0;
  const maxPrefix = Math.min(previous.length, current.length);
  while (sharedPrefixLength < maxPrefix && previous[sharedPrefixLength] === current[sharedPrefixLength]) {
    sharedPrefixLength += 1;
  }

  return current.slice(sharedPrefixLength);
}

async function hasRecentActivitySignal(workspacePath: string): Promise<boolean> {
  const [recentCommit, sessionMtime] = await Promise.all([
    hasRecentCommits(workspacePath),
    getCursorSessionMtime(workspacePath)
  ]);

  if (recentCommit) {
    return true;
  }

  if (!sessionMtime) {
    return false;
  }

  return Date.now() - sessionMtime.getTime() <= ACTIVE_WINDOW_MS;
}

async function hasRecentCommits(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `--since=${RECENT_COMMIT_WINDOW_SECONDS} seconds ago`, "--format=%H"],
      { cwd: workspacePath, timeout: 5_000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function getCursorSessionMtime(workspacePath: string): Promise<Date | null> {
  try {
    const cursorDir = join(workspacePath, CURSOR_DIR_NAME);
    const chatFile = join(cursorDir, CURSOR_CHAT_FILE);

    const dirStats = await lstat(cursorDir);
    if (dirStats.isSymbolicLink()) {
      return null;
    }

    try {
      const fileStats = await lstat(chatFile);
      if (fileStats.isSymbolicLink()) {
        return null;
      }
      const current = await stat(chatFile);
      return current.mtime;
    } catch {
      await access(cursorDir, constants.R_OK);
      const current = await stat(cursorDir);
      return current.mtime;
    }
  } catch {
    return null;
  }
}

async function extractCursorSummary(workspacePath: string): Promise<string | null> {
  try {
    const cursorDir = join(workspacePath, CURSOR_DIR_NAME);
    const chatFile = join(cursorDir, CURSOR_CHAT_FILE);

    const dirStats = await lstat(cursorDir);
    if (dirStats.isSymbolicLink()) {
      return null;
    }

    const fileStats = await lstat(chatFile);
    if (fileStats.isSymbolicLink()) {
      return null;
    }

    const resolvedChatPath = resolve(chatFile);
    const resolvedWorkspacePath = resolve(workspacePath);
    if (!resolvedChatPath.startsWith(resolvedWorkspacePath)) {
      return null;
    }

    const content = await readFile(chatFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      return trimmed.length > SUMMARY_MAX_LENGTH ? `${trimmed.slice(0, SUMMARY_MAX_LENGTH)}...` : trimmed;
    }
  } catch {
    return null;
  }

  return null;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_/:=+.,@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
