import { Command } from "commander";
import { registerAgentCommands } from "./commands/agent.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerDoctorCommands } from "./commands/doctor.js";
import { registerRepoCommands } from "./commands/repo.js";
import { registerServeCommands } from "./commands/serve.js";
import { registerWorkCommands } from "./commands/work.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerWorktreeCommands } from "./commands/worktree.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("devtask")
    .description("Local control plane for multi-work, multi-repo agent-assisted development.")
    .version("1.0.0");

  registerAgentCommands(program);
  registerWorkspaceCommands(program);
  registerRepoCommands(program);
  registerServeCommands(program);
  registerWorkCommands(program);
  registerWorktreeCommands(program);
  registerConfigCommands(program);
  registerDoctorCommands(program);

  return program;
}
