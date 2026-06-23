import { buildClaudeCodeCommand, buildCodexExecCommand, buildCursorCommand } from "@devtask/agent-kernel";
import type { DevtaskConfig } from "../../infra/config.js";
import type { AgentStartOptions } from "./run-once.js";

export function buildAgentBootstrapCommand(config: DevtaskConfig, options: AgentStartOptions): string {
  if (config.agent.provider === "codex") {
    return buildCodexExecCommand({
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
  return buildCursorCommand({
    model: options.model ?? config.codex.model ?? null,
    fullAuto: options.fullAuto
  });
}
