import crypto from "node:crypto";
import path from "node:path";
import type { Agent, AgentSessionInfo, RunEvent, RunOptions } from "../agent/agent.js";
import type { PreparedSessionInstructions } from "../instructions/instruction-payload.js";
import type { Runtime, RuntimeHandle } from "../runtime/runtime.js";
import { buildCodexInteractiveResumeCommand, buildCodexInteractiveStartCommand } from "../../adapters/codex/command.js";
import {
  configureManagedHooks,
  extractAssistantSummary,
  extractThreadId,
  findSessionFileCached,
  prepareIsolatedCodexHome,
} from "../../adapters/codex/index.js";

export interface InteractiveCodexAgentConfig {
  model?: string;
  fullAuto?: boolean;
  sessionRoot?: string;
}

export interface InteractiveCodexLaunchOptions {
  taskDir?: string | null;
  addDirs?: readonly string[];
  managedCompletionCommand?: string | null;
}

export class InteractiveCodexAgent implements Agent {
  readonly name = "codex";
  readonly promptDelivery = "inline" as const;

  constructor(private readonly config: InteractiveCodexAgentConfig = {}) {}

  getEnvironment(_workspacePath: string): Record<string, string> {
    return { CODEX_DISABLE_UPDATE_CHECK: "1" };
  }

  async getLaunchCommand(_workspacePath: string, _instructions?: PreparedSessionInstructions): Promise<string> {
    throw new Error("InteractiveCodexAgent requires an explicit launch command");
  }

  async *readEvents(_handle: RuntimeHandle, _runtime: Runtime, _opts?: RunOptions): AsyncIterable<RunEvent> {
    throw new Error("InteractiveCodexAgent does not support streaming through the kernel readEvents API");
  }

  createLaunchCommand(
    prompt: string,
    handleId: string,
    options: InteractiveCodexLaunchOptions = {},
  ): { command: string; metadata: Record<string, unknown> } {
    const codexHome = prepareIsolatedCodexHome(
      options.taskDir ?? null,
      handleId,
      this.config.sessionRoot ?? null,
    );
    configureManagedHooks(codexHome, options.managedCompletionCommand ?? null);
    const taskDirs = options.taskDir?.trim() ? [options.taskDir] : [];
    return {
      command: buildCodexInteractiveStartCommand(prompt, {
        codexHome,
        model: this.config.model ?? null,
        fullAuto: this.config.fullAuto,
        addDirs: [...taskDirs, ...(options.addDirs ?? [])],
        bypassHookTrust: Boolean(options.managedCompletionCommand?.trim()),
      }),
      metadata: {
        codexHome,
        transcriptPath: null,
        threadId: null,
      },
    };
  }

  async getRestoreCommand(handle: RuntimeHandle): Promise<string | null> {
    const threadId = typeof handle.data["threadId"] === "string" ? handle.data["threadId"] : null;
    if (!threadId) {
      return null;
    }

    const codexHome = typeof handle.data["codexHome"] === "string" ? handle.data["codexHome"] : null;
    const model = typeof handle.data["codexModel"] === "string" ? handle.data["codexModel"] : this.config.model ?? null;
    const prompt = typeof handle.data["resumePrompt"] === "string" && handle.data["resumePrompt"].trim()
      ? handle.data["resumePrompt"]
      : null;
    return buildCodexInteractiveResumeCommand(threadId, {
      codexHome,
      model,
      prompt,
      bypassHookTrust: Boolean(codexHome),
    });
  }

  async getSessionInfo(handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    const workspacePath = typeof handle.data["workspacePath"] === "string" ? handle.data["workspacePath"] : null;
    const codexHome = typeof handle.data["codexHome"] === "string" ? handle.data["codexHome"] : null;
    if (!workspacePath || !codexHome) {
      return null;
    }

    const transcriptPath = await this.resolveTranscriptPath(handle, workspacePath, codexHome);
    if (!transcriptPath) {
      return {
        summary: "Codex session started",
        summaryIsFallback: true,
        agentSessionId: handle.id,
      };
    }

    const threadId = typeof handle.data["threadId"] === "string"
      ? handle.data["threadId"]
      : await extractThreadId(transcriptPath);
    const summary = await extractAssistantSummary(transcriptPath);
    if (threadId) {
      handle.data["threadId"] = threadId;
    }
    handle.data["transcriptPath"] = transcriptPath;

    return {
      summary: summary ?? "Codex session completed",
      summaryIsFallback: !summary,
      agentSessionId: threadId ?? handle.id,
      metadata: {
        transcriptPath,
        ...(threadId ? { threadId } : {}),
      },
    };
  }

  private async resolveTranscriptPath(
    handle: RuntimeHandle,
    workspacePath: string,
    codexHome: string,
  ): Promise<string | null> {
    const existing = typeof handle.data["transcriptPath"] === "string" ? handle.data["transcriptPath"] : null;
    if (existing) {
      return existing;
    }

    const startedAt = typeof handle.data["startedAtMs"] === "number" ? handle.data["startedAtMs"] : undefined;
    const transcriptPath = await findSessionFileCached(path.join(codexHome, "sessions"), workspacePath, startedAt);
    if (transcriptPath) {
      handle.data["transcriptPath"] = transcriptPath;
    }
    return transcriptPath;
  }
}

export function createInteractiveKernelSessionId(prefix = "devtask"): string {
  return `${prefix}-session-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
