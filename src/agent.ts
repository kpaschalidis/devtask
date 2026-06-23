import fs from "node:fs";
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

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
