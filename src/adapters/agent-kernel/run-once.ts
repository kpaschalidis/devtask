import fs from "node:fs";
import {
  CodexExecAgent,
  InMemorySessionHistoryStore,
  NoopWorkspaceSetup,
  runOnce,
  SessionCoordinator,
  SessionHistoryCaptureService,
  type Runtime,
} from "@devtask/agent-kernel";
import type { DevtaskConfig } from "../../infra/config.js";
import type { AgentSessionRef } from "../../infra/session-ref.js";

export interface AgentStartOptions {
  workspacePath: string;
  model?: string | null;
  fullAuto?: boolean;
  skipGitRepoCheck?: boolean;
  addDirs?: readonly string[];
  env?: Record<string, string>;
  managedCompletionCommand?: string | null;
}

export interface RunOptions {
  stallMs?: number;
  maxTurnMs?: number;
}

export interface AgentPromptResult {
  status: "completed" | "failed" | "input_required" | "stalled";
  error: string | null;
  session: AgentSessionRef;
}

const NOOP_RUNTIME: Runtime = {
  name: "noop-runtime",
  create: async () => {
    throw new Error("Noop runtime cannot create sessions");
  },
  destroy: async () => {},
  sendMessage: async () => {},
  isAlive: async () => true,
};

export async function runKernelOneShot(
  config: DevtaskConfig,
  startOptions: AgentStartOptions,
  prompt: string,
  options: {
    outputPath: string;
    runOptions?: RunOptions;
    onOutput?: (chunk: string) => void;
  },
): Promise<AgentPromptResult | null> {
  if (config.agent.provider !== "codex") {
    return null;
  }

  const output = fs.createWriteStream(options.outputPath, { flags: "w" });
  const agent = new CodexExecAgent({
    model: startOptions.model ?? config.codex.model ?? undefined,
    sessionRoot: config.agentSessions.roots.codex ?? undefined,
    fullAuto: startOptions.fullAuto,
    skipGitRepoCheck: startOptions.skipGitRepoCheck,
    addDirs: startOptions.addDirs,
  });
  const coordinator = new SessionCoordinator({
    agent,
    runtime: NOOP_RUNTIME,
    workspaceSetup: new NoopWorkspaceSetup(),
    sessionHistory: new SessionHistoryCaptureService(new InMemorySessionHistoryStore()),
    logger: { warn: () => {} },
    artifactPrefix: "devtask",
  });

  try {
    const result = await runOnce({
      coordinator,
      workspacePath: startOptions.workspacePath,
      prompt,
      runOptions: options.runOptions,
      onEvent: (event) => {
        if (event.kind === "output") {
          output.write(event.text);
          options.onOutput?.(event.text);
        }
      },
    });
    return {
      status: result.status,
      error: result.error,
      session: {
        provider: "codex",
        transportId: result.handle.id,
        resumeContext: {
          providerSessionId: typeof result.handle.data["threadId"] === "string" ? result.handle.data["threadId"] : result.sessionInfo?.agentSessionId ?? null,
          conversationId: typeof result.handle.data["threadId"] === "string" ? result.handle.data["threadId"] : result.sessionInfo?.agentSessionId ?? null,
          resumeTarget: typeof result.handle.data["threadId"] === "string" ? result.handle.data["threadId"] : result.sessionInfo?.agentSessionId ?? null,
          storageRoot: typeof result.handle.data["codexHome"] === "string" ? result.handle.data["codexHome"] : null,
          transcriptPath: typeof result.handle.data["transcriptPath"] === "string" ? result.handle.data["transcriptPath"] : null,
        },
        summary: result.sessionInfo?.summary ?? null,
        summaryIsFallback: result.sessionInfo?.summaryIsFallback ?? null,
      },
    };
  } finally {
    await closeStream(output);
  }
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
