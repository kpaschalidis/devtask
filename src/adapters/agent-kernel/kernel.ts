import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DevtaskConfig } from "../../infra/config.js";
import type { DevtaskPaths } from "../../infra/paths.js";
import type { Agent } from "../../kernel/agent/agent.js";
import type { Runtime } from "../../kernel/runtime/runtime.js";
import { SessionCoordinator } from "../../kernel/sessions/session-coordinator.js";
import { SqliteSessionHistoryStore } from "../../kernel/storage/sqlite/session-history-store.js";
import { SessionHistoryCaptureService } from "../../kernel/trace/session-history-capture-service.js";
import type { SessionHistoryEvent } from "../../kernel/trace/session-history.js";
import { NoopWorkspaceSetup } from "../../kernel/workspace/workspace-setup.js";
import { InteractiveCodexAgent } from "./codex-interactive.js";
import { InteractiveClaudeCodeAgent } from "./claude-code-interactive.js";
import { DevtaskTmuxRuntime } from "./tmux-runtime.js";

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
  const db = new DatabaseSync(dbPath);

  const sessionHistoryStore = new SqliteSessionHistoryStore(db);
  const sessionHistory = new SessionHistoryCaptureService(
    sessionHistoryStore,
    options.onSessionHistoryEvent,
  );
  const agent = createKernelAgent(config);
  const runtime = createKernelRuntime();
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
    close() {
      db.close();
    },
  };
}

export function kernelSessionHistoryPath(paths: DevtaskPaths): string {
  return path.join(paths.localDir, "kernel", "session-history.sqlite");
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

function createKernelRuntime(): Runtime {
  return new DevtaskTmuxRuntime();
}

function normalizeLogger(logger: DevtaskKernelLogger | undefined): Required<DevtaskKernelLogger> {
  return {
    info: logger?.info ?? (() => {}),
    warn: logger?.warn ?? (() => {}),
    error: logger?.error ?? (() => {}),
  };
}
