import fs from "node:fs";
import path from "node:path";
import type { DevtaskConfig } from "../../infra/config.js";
import type { DevtaskPaths } from "../../infra/paths.js";
import type { Agent } from "@devtask/agent-kernel";
import type { AttachInfo, Runtime, RuntimeHandle } from "@devtask/agent-kernel";
import {
  InteractiveClaudeCodeAgent,
  InteractiveCodexAgent,
  NoopWorkspaceSetup,
  openPersistentSessionHistoryStore,
  SessionCoordinator,
  SessionHistoryCaptureService,
} from "@devtask/agent-kernel";
import type { SessionHistoryEvent } from "@devtask/agent-kernel";
import type { KernelSessionRef } from "../../infra/session-run.js";
import {
  attachTmuxSession,
  captureOutputAsync,
  createBareSession,
  killTmuxSession,
  sendLaunchCommand,
  sendMessageAsync,
  tmuxSessionExists,
} from "./tmux-control.js";

export interface DevtaskKernelLogger {
  info?(meta: Record<string, unknown>, message: string): void;
  warn?(meta: Record<string, unknown>, message: string): void;
  error?(meta: Record<string, unknown>, message: string): void;
}

export interface DevtaskKernelHandle {
  agent: Agent;
  runtime: Runtime;
  coordinator: SessionCoordinator;
  sessionHistory: SessionHistoryCaptureService;
  sessionHistoryBackend: "sqlite" | "file";
  close(): void;
}

export interface CreateDevtaskKernelOptions {
  logger?: DevtaskKernelLogger;
  onSessionHistoryEvent?: (event: SessionHistoryEvent) => void;
}

export function createDevtaskKernel(
  paths: DevtaskPaths,
  config: DevtaskConfig,
  options: CreateDevtaskKernelOptions = {},
): DevtaskKernelHandle {
  const logger = normalizeLogger(options.logger);
  const dbPath = kernelSessionHistoryPath(paths);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sessionHistoryHandle = openPersistentSessionHistoryStore(dbPath);
  const sessionHistory = new SessionHistoryCaptureService(
    sessionHistoryHandle.store,
    options.onSessionHistoryEvent,
  );
  const agent = createKernelAgent(config);
  const runtime = createKernelRuntime(config);
  const coordinator = new SessionCoordinator({
    agent,
    runtime,
    workspaceSetup: new NoopWorkspaceSetup(),
    sessionHistory,
    logger,
    artifactPrefix: "devtask",
  });

  return {
    agent,
    runtime,
    coordinator,
    sessionHistory,
    sessionHistoryBackend: sessionHistoryHandle.backend,
    close() {
      sessionHistoryHandle.close();
    },
  };
}

export async function launchDevtaskRuntimeSession(config: {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
}): Promise<KernelSessionRef> {
  const runtime = createKernelRuntime();
  const handle = await runtime.create({
    sessionId: config.sessionId,
    workspacePath: config.workspacePath,
    launchCommand: config.launchCommand,
    environment: {},
  });
  return {
    runtimeSessionId: handle.id,
    runtimeName: handle.runtimeName,
    threadId: null,
    data: { ...handle.data },
  };
}

function createKernelAgent(config: DevtaskConfig): Agent {
  if (config.agent.provider === "claude-code") {
    return new InteractiveClaudeCodeAgent({
      model: config.codex.model ?? undefined,
      fullAuto: config.codex.fullAuto,
    });
  }

  if (config.agent.provider !== "codex") {
    throw new Error(`Kernel bootstrap does not support agent provider: ${config.agent.provider}`);
  }

  return new InteractiveCodexAgent({
    model: config.codex.model ?? undefined,
    fullAuto: config.codex.fullAuto,
    sessionRoot: config.agentSessions.roots.codex ?? undefined,
  });
}

function createKernelRuntime(_config?: DevtaskConfig): Runtime {
  return new DevtaskTmuxRuntime();
}

function kernelSessionHistoryPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "kernel", "session-history.sqlite");
}

function normalizeLogger(logger: DevtaskKernelLogger | undefined): Required<DevtaskKernelLogger> {
  return {
    info: logger?.info ?? (() => {}),
    warn: logger?.warn ?? (() => {}),
    error: logger?.error ?? (() => {}),
  };
}

class DevtaskTmuxRuntime implements Runtime {
  readonly name = "tmux";

  async create(config: { sessionId: string; workspacePath: string; launchCommand: string }): Promise<RuntimeHandle> {
    createBareSession(config.sessionId, config.workspacePath);
    sendLaunchCommand(config.sessionId, config.launchCommand);
    return {
      id: config.sessionId,
      runtimeName: this.name,
      data: {
        sessionName: config.sessionId,
        workspacePath: config.workspacePath,
      },
    };
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    killTmuxSession(handle.id);
  }

  async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
    await sendMessageAsync(handle.id, message);
  }

  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    return tmuxSessionExists(handle.id);
  }

  async captureOutput(handle: RuntimeHandle, lines?: number): Promise<string> {
    return captureOutputAsync(handle.id, lines);
  }

  getAttachInfo(handle: RuntimeHandle): AttachInfo {
    return {
      command: `tmux attach -t ${handle.id}`,
      description: `Attach to tmux session ${handle.id}`,
    };
  }
}
