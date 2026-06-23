import fs from "node:fs";
import { spawn } from "node:child_process";
import type { AgentProvider, AgentSessionRef } from "./agent-session.js";
import { CodexAgentRunner } from "./adapters/codex/index.js";
import { buildCodexCommand } from "./adapters/codex/command.js";
import { CursorAgentRunner } from "./adapters/cursor/index.js";
import { buildClaudeCodeCommand } from "./adapters/claude-code/command.js";
import type { DevtaskConfig } from "./infra/config.js";

export interface SessionHandle {
  id: string;
  provider: AgentProvider;
  providerSessionId?: string | null;
  conversationId?: string | null;
  resumeTarget?: string | null;
  storageRoot?: string | null;
  transcriptPath?: string | null;
}

export type ActivityState = "idle" | "active" | "waiting_input" | "errored" | "unknown";

export interface AgentStartOptions {
  workspacePath: string;
  model?: string | null;
  fullAuto?: boolean;
  skipGitRepoCheck?: boolean;
  addDirs?: readonly string[];
  env?: Record<string, string>;
  managedCompletionCommand?: string | null;
}

export interface AgentResumeOptions {
  workspacePath: string;
  model?: string | null;
  prompt?: string | null;
  managedCompletionCommand?: string | null;
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
  getSessionInfo?(session: SessionHandle): Promise<Pick<AgentSessionRef, "summary" | "summaryIsFallback"> | null>;
  stop?(session: SessionHandle): Promise<void>;
  buildStartCommand?(options: AgentStartOptions): string;
  buildInteractiveStartCommand?(options: AgentStartOptions, prompt: string): Promise<{ command: string; session: AgentSessionRef }> | { command: string; session: AgentSessionRef };
  buildResumeCommand?(session: AgentSessionRef, options: AgentResumeOptions): string | null;
  buildInteractiveResumeCommand?(session: AgentSessionRef, options: AgentResumeOptions): string | null;
  installCompletionHook?(session: AgentSessionRef, command: string | null): void;
  hydrateSessionRef?(session: AgentSessionRef, workspacePath: string): Promise<AgentSessionRef>;
}

export interface AgentPromptResult {
  status: "completed" | "failed" | "input_required" | "stalled";
  error: string | null;
  session: AgentSessionRef;
}

export function createDefaultAgentRunner(config: DevtaskConfig): AgentRunner {
  if (config.agent.provider === "cursor") {
    return new CursorAgentRunner({
      model: config.codex.model ?? undefined
    });
  }

  return new CodexAgentRunner({
    model: config.codex.model ?? undefined,
    sessionRoot: config.agentSessions.roots.codex ?? undefined
  });
}

export function buildAgentBootstrapCommand(config: DevtaskConfig, options: AgentStartOptions): string {
  if (config.agent.provider === "codex") {
    return buildCodexCommand({
      model: options.model ?? config.codex.model ?? null,
      fullAuto: options.fullAuto,
      skipGitRepoCheck: options.skipGitRepoCheck,
      addDirs: options.addDirs
    });
  }
  if (config.agent.provider === "claude-code") {
    return buildClaudeCodeCommand({
      model: options.model ?? config.codex.model ?? null,
      dangerouslySkipPermissions: config.codex.fullAuto !== false
    });
  }
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
        provider: session.provider,
        transportId: session.id ?? null,
        resumeContext: {
          providerSessionId: session.providerSessionId ?? null,
          conversationId: session.conversationId ?? null,
          resumeTarget: session.resumeTarget ?? null,
          storageRoot: session.storageRoot ?? null,
          transcriptPath: session.transcriptPath ?? null
        },
        summary: sessionInfo?.summary ?? null,
        summaryIsFallback: sessionInfo?.summaryIsFallback ?? null
      }
    };
  }
}

export async function resumeAgentPrompt(
  runner: AgentRunner,
  session: AgentSessionRef,
  resumeOptions: AgentResumeOptions,
  prompt: string,
  options: {
    outputPath: string;
    runOptions?: RunOptions;
    onOutput?: (chunk: string) => void;
  }
): Promise<AgentPromptResult> {
  const command = runner.buildResumeCommand?.(session, {
    workspacePath: resumeOptions.workspacePath,
    model: resumeOptions.model ?? null,
    prompt
  });
  if (!command) {
    return {
      status: "failed",
      error: `Agent provider ${session.provider} does not support session resume`,
      session
    };
  }

  const output = fs.createWriteStream(options.outputPath, { flags: "w" });
  const stallMs = options.runOptions?.stallMs ?? 120_000;
  const maxTurnMs = options.runOptions?.maxTurnMs ?? 600_000;
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const child = spawn(shell, ["-lc", command], {
    cwd: resumeOptions.workspacePath,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let status: AgentPromptResult["status"] = "failed";
  let error: string | null = null;
  let lastActivityAt = Date.now();
  let exited = false;
  let exitCode: number | null = null;
  let stalled = false;
  const stderrChunks: string[] = [];

  const killChild = (): void => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const maxTimer = setTimeout(() => {
    stalled = true;
    killChild();
  }, maxTurnMs);

  const stallTimer = setInterval(() => {
    if (Date.now() - lastActivityAt > stallMs && !exited) {
      stalled = true;
      killChild();
    }
  }, 250);

  child.stdout.on("data", (chunk: string) => {
    lastActivityAt = Date.now();
    output.write(chunk);
    options.onOutput?.(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    lastActivityAt = Date.now();
    stderrChunks.push(chunk);
    output.write(chunk);
    options.onOutput?.(chunk);
  });

  await new Promise<void>((resolve) => {
    child.on("error", (spawnError) => {
      error = spawnError.message;
      exited = true;
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      exited = true;
      resolve();
    });
  });

  clearTimeout(maxTimer);
  clearInterval(stallTimer);

  try {
    const ctx = session.resumeContext;
    const pseudoHandle: SessionHandle = {
      id: session.transportId ?? ctx.resumeTarget ?? ctx.providerSessionId ?? ctx.conversationId ?? "resume",
      provider: session.provider,
      providerSessionId: ctx.providerSessionId,
      conversationId: ctx.conversationId,
      resumeTarget: ctx.resumeTarget,
      storageRoot: ctx.storageRoot,
      transcriptPath: ctx.transcriptPath
    };
    const sessionInfo = await runner.getSessionInfo?.(pseudoHandle);
    await closeStream(output);

    if (!stalled) {
      if (error) {
        status = "failed";
      } else if (exitCode === 0) {
        status = "completed";
      } else {
        status = "failed";
        error = stderrChunks.join("").trim() || `Resume command exited with code ${exitCode ?? "unknown"}`;
      }
    } else {
      status = "stalled";
    }

    return {
      status,
      error,
      session: {
        ...session,
        summary: sessionInfo?.summary ?? session.summary,
        summaryIsFallback: sessionInfo?.summaryIsFallback ?? session.summaryIsFallback
      }
    };
  } finally {
    if (!exited) {
      killChild();
    }
  }
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
