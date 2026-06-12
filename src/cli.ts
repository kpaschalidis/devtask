import { Command } from "commander";
import { registerAgentCommands } from "./cli/agent.js";
import { registerBoardCommands } from "./cli/board.js";
import { registerConfigCommands } from "./cli/config.js";
import { registerRepoCommands } from "./cli/repo.js";
import { registerWorkCommands } from "./cli/work.js";
import { registerWorkspaceCommands } from "./cli/workspace.js";
import { registerWorktreeCommands } from "./cli/worktree.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("devtask")
    .description("Local control plane for multi-work, multi-repo agent-assisted development.")
    .version("1.0.0");

  registerAgentCommands(program);
  registerWorkspaceCommands(program);
  registerRepoCommands(program);
  registerWorkCommands(program);
  registerBoardCommands(program);
  registerWorktreeCommands(program);
  registerConfigCommands(program);

  return program;
}
