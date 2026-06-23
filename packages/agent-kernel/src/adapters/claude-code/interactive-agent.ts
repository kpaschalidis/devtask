import type { Agent, AgentSessionInfo, RunEvent, RunOptions } from '../../agent/agent.js';
import type { PreparedSessionInstructions } from '../../instructions/instruction-payload.js';
import type { Runtime, RuntimeHandle } from '../../runtime/runtime.js';
import { buildClaudeCodeInteractiveStartCommand } from './command.js';

export interface InteractiveClaudeCodeAgentConfig {
  model?: string;
  fullAuto?: boolean;
  nodeExecPath?: string | null;
}

export class InteractiveClaudeCodeAgent implements Agent {
  readonly name = 'claude-code';
  readonly promptDelivery = 'inline' as const;

  constructor(private readonly config: InteractiveClaudeCodeAgentConfig = {}) {}

  getEnvironment(_workspacePath: string): Record<string, string> {
    return {};
  }

  async getLaunchCommand(_workspacePath: string, _instructions?: PreparedSessionInstructions): Promise<string> {
    throw new Error('InteractiveClaudeCodeAgent requires createLaunchCommand with an explicit prompt');
  }

  async *readEvents(_handle: RuntimeHandle, _runtime: Runtime, _opts?: RunOptions): AsyncIterable<RunEvent> {
    throw new Error('InteractiveClaudeCodeAgent does not support streaming through readEvents');
  }

  createLaunchCommand(
    prompt: string,
    _handleId: string,
    options: { taskDir?: string | null; addDirs?: readonly string[]; managedCompletionCommand?: string | null } = {},
  ): { command: string; metadata: Record<string, unknown> } {
    return {
      command: buildClaudeCodeInteractiveStartCommand(prompt, {
        model: this.config.model ?? null,
        dangerouslySkipPermissions: this.config.fullAuto !== false,
        completionCommand: options.managedCompletionCommand,
        nodeExecPath: this.config.nodeExecPath ?? null,
      }),
      metadata: {
        threadId: null,
        transcriptPath: null,
      },
    };
  }

  async getSessionInfo(handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    return {
      summary: 'Claude Code session completed',
      summaryIsFallback: true,
      agentSessionId: handle.id,
    };
  }
}
