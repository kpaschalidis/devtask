import fs from "node:fs";
import { CodexAgentRunner } from "./adapters/codex/index.js";
import { CursorAgentRunner } from "./adapters/cursor/index.js";
import type { DevtaskConfig } from "./infra/config.js";
import { captureOutputAsync, getForegroundCommand, isSessionAliveAsync, sendKeyAsync } from "./infra/tmux.js";

export interface SessionHandle {
  id: string;
  threadId?: string | null;
}

export type ActivityState = "idle" | "active" | "waiting_input" | "errored" | "unknown";

export interface AgentStartOptions {
  workspacePath: string;
  model?: string | null;
  fullAuto?: boolean;
  skipGitRepoCheck?: boolean;
  addDirs?: readonly string[];
  env?: Record<string, string>;
}

export interface RunOptions {
  stallMs?: number;
  maxTurnMs?: number;
}

export type RunEvent =
  | { kind: "output"; text: string }
  | { kind: "input_required"; prompt: string }
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "stalled" }
  | { kind: "turn_complete" };

export interface AgentRunner {
  start(options: AgentStartOptions): Promise<SessionHandle>;
  run(session: SessionHandle, prompt: string, options?: RunOptions): AsyncIterable<RunEvent>;
  sendInput?(session: SessionHandle, message: string): Promise<void>;
  isAlive?(session: SessionHandle): Promise<boolean>;
  getActivityState?(session: SessionHandle): Promise<ActivityState>;
  getSessionInfo?(session: SessionHandle): Promise<{ summary: string; summaryIsFallback: boolean; agentSessionId: string | null } | null>;
  stop?(session: SessionHandle): Promise<void>;
  buildStartCommand?(options: AgentStartOptions): string;
}

export interface AgentPromptResult {
  status: "completed" | "failed" | "input_required" | "stalled";
  error: string | null;
  session: {
    transportSessionId: string | null;
    threadId: string | null;
    agentSessionId: string | null;
    summary: string | null;
    summaryIsFallback: boolean | null;
  };
}

export function createDefaultAgentRunner(config: DevtaskConfig): AgentRunner {
  if (config.agent.provider === "cursor") {
    return new CursorAgentRunner({
      model: config.codex.model ?? undefined
    });
  }

  return new CodexAgentRunner({
    model: config.codex.model ?? undefined
  });
}

export function buildAgentBootstrapCommand(config: DevtaskConfig, options: AgentStartOptions): string {
  const runner = createDefaultAgentRunner(config);
  return runner.buildStartCommand?.(options) ?? "agent-run";
}

export async function runAgentPrompt(
  runner: AgentRunner,
  startOptions: AgentStartOptions,
  prompt: string,
  options: {
    outputPath: string;
    runOptions?: RunOptions;
    onOutput?: (chunk: string) => void;
  }
): Promise<AgentPromptResult> {
  const output = fs.createWriteStream(options.outputPath, { flags: "w" });
  const session = await runner.start(startOptions);

  let status: AgentPromptResult["status"] = "failed";
  let error: string | null = null;
  try {
    for await (const event of runner.run(session, prompt, options.runOptions)) {
      if (event.kind === "output") {
        output.write(event.text);
        options.onOutput?.(event.text);
        continue;
      }

      if (event.kind === "completed") {
        status = "completed";
        break;
      }

      if (event.kind === "input_required") {
        status = "input_required";
        error = event.prompt;
        break;
      }

      if (event.kind === "stalled") {
        status = "stalled";
        break;
      }

      if (event.kind === "failed") {
        status = "failed";
        error = event.error;
        break;
      }
    }
  } finally {
    const sessionInfo = await runner.getSessionInfo?.(session);
    await closeStream(output);
    if (runner.stop) {
      await runner.stop(session);
    }
    return {
      status,
      error,
      session: {
        transportSessionId: session.id ?? null,
        threadId: session.threadId ?? null,
        agentSessionId: sessionInfo?.agentSessionId ?? null,
        summary: sessionInfo?.summary ?? null,
        summaryIsFallback: sessionInfo?.summaryIsFallback ?? null
      }
    };
  }
}

export const CODEX_PROCESS_NAME = "codex";
export const CURSOR_PROCESS_NAME = "cursor";
export const CLAUDE_PROCESS_NAME = "claude";

const FOREGROUND_ALIASES: Record<string, string[]> = {
  codex: ["codex", "node"],
  cursor: ["agent", "node"],
  claude: ["claude", "node"]
};

const UPDATE_PROMPT_RE = /Update available!/;

export async function waitForAgentReady(
  session: string,
  processName: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const validForegrounds = new Set(FOREGROUND_ALIASES[processName] ?? [processName]);
  let stableCount = 0;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const [alive, foreground, output] = await Promise.all([
      isSessionAliveAsync(session),
      getForegroundCommand(session),
      captureOutputAsync(session, 20)
    ]);

    if (!alive) return false;

    if (UPDATE_PROMPT_RE.test(output)) {
      await sendKeyAsync(session, "Down");
      await sleep(200);
      await sendKeyAsync(session, "Enter");
      stableCount = 0;
      lastOutput = "";
      await sleep(pollMs);
      continue;
    }

    const isActive = foreground !== null && validForegrounds.has(foreground);
    if (!isActive) {
      stableCount = 0;
      lastOutput = "";
      await sleep(pollMs);
      continue;
    }

    if (output === lastOutput) {
      stableCount++;
    } else {
      stableCount = 0;
      lastOutput = output;
    }

    if (stableCount >= 2) return true;

    await sleep(pollMs);
  }

  return false;
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
