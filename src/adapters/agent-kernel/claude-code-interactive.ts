import type { Agent, AgentSessionInfo, RunEvent, RunOptions } from "@devtask/agent-kernel";
import type { PreparedSessionInstructions } from "@devtask/agent-kernel";
import type { Runtime, RuntimeHandle } from "@devtask/agent-kernel";
import { buildClaudeCodeInteractiveStartCommand } from "../claude-code/command.js";

export interface InteractiveClaudeCodeAgentConfig {
  model?: string;
  fullAuto?: boolean;
}

export interface InteractiveClaudeCodeLaunchOptions {
  taskDir?: string | null;
  addDirs?: readonly string[];
  managedCompletionCommand?: string | null;
}

export class InteractiveClaudeCodeAgent implements Agent {
  readonly name = "claude-code";
  readonly promptDelivery = "inline" as const;

  constructor(private readonly config: InteractiveClaudeCodeAgentConfig = {}) {}

  getEnvironment(_workspacePath: string): Record<string, string> {
    return {};
  }

  async getLaunchCommand(
    _workspacePath: string,
    _instructions?: PreparedSessionInstructions,
  ): Promise<string> {
    throw new Error("InteractiveClaudeCodeAgent requires createLaunchCommand with an explicit prompt");
  }

  async *readEvents(
    _handle: RuntimeHandle,
    _runtime: Runtime,
    _opts?: RunOptions,
  ): AsyncIterable<RunEvent> {
    throw new Error("InteractiveClaudeCodeAgent does not support streaming through readEvents");
  }

  createLaunchCommand(
    prompt: string,
    _handleId: string,
    options: InteractiveClaudeCodeLaunchOptions = {},
  ): { command: string; metadata: Record<string, unknown> } {
    return {
      command: buildClaudeCodeInteractiveStartCommand(prompt, {
        model: this.config.model ?? null,
        dangerouslySkipPermissions: this.config.fullAuto !== false,
        completionCommand: options.managedCompletionCommand ?? null,
        nodeExecPath: process.execPath,
      }),
      metadata: {
        transcriptPath: null,
        threadId: null,
      },
    };
  }

  async getRestoreCommand(_handle: RuntimeHandle): Promise<string | null> {
    return null;
  }

  async isAlive(_handle: RuntimeHandle): Promise<boolean> {
    return false;
  }

  async getSessionInfo(_handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    return null;
  }
}
