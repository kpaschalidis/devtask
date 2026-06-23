import { Command } from "commander";
import { registerAgentCommands } from "./cli/agent.js";
import { registerConfigCommands } from "./cli/config.js";
import { registerDoctorCommands } from "./cli/doctor.js";
import { registerRepoCommands } from "./cli/repo.js";
import { registerServeCommands } from "./cli/serve.js";
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
  registerServeCommands(program);
  registerWorkCommands(program);
  registerWorktreeCommands(program);
  registerConfigCommands(program);
  registerDoctorCommands(program);

  return program;
}
