import { Command } from "commander";
import { resolveWorkspacePaths } from "devtask/infra/paths";
import { cleanupWorktrees, listWorktrees } from "devtask/services/worktree-service";
import { printError, printTable } from "../common.js";

export function registerWorktreeCommands(program: Command): void {
  const worktree = program.command("worktree").description("Inspect and clean up repo-local worktrees.");

  worktree
    .command("list")
    .description("List worktrees for one work item.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        const rows = listWorktrees(resolveWorkspacePaths(), workId);
        if (rows.length === 0) {
          console.log("No worktrees");
          return;
        }
        printTable(
          ["REPO", "TASK", "BRANCH", "PATH"],
          rows.map((row) => [row.repoId, row.taskId, row.branch, row.path])
        );
      } catch (error) {
        printError(error);
      }
    });

  worktree
    .command("cleanup")
    .description("Clean up worktrees for one work item.")
    .argument("<work-id>")
    .option("--dry-run", "Preview cleanup actions")
    .action(async (workId: string, options: { dryRun?: boolean }) => {
      try {
        const result = await cleanupWorktrees(resolveWorkspacePaths(), workId, options.dryRun === true);
        if (result.blockers.length > 0) {
          console.log("Blockers:");
          for (const blocker of result.blockers) {
            console.log(`- ${blocker}`);
          }
        }
        for (const action of result.actions) {
          console.log(`- ${action}`);
        }
      } catch (error) {
        printError(error);
      }
    });
}
