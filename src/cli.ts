import { Command } from "commander";
import { registerBoardCommands } from "./cli/board.js";
import { registerConfigCommands } from "./cli/config.js";
import { registerRepoCommands } from "./cli/repo.js";
import { registerSessionCommands } from "./cli/session.js";
import { registerWorkCommands } from "./cli/work.js";
import { registerWorkspaceCommands } from "./cli/workspace.js";
import { registerWorktreeCommands } from "./cli/worktree.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("devtask")
    .description("Local control plane for multi-work, multi-repo agent-assisted development.")
    .version("1.0.0");

  registerWorkspaceCommands(program);
  registerRepoCommands(program);
  registerWorkCommands(program);
  registerSessionCommands(program);
  registerBoardCommands(program);
  registerWorktreeCommands(program);
  registerConfigCommands(program);

  return program;
}
