import { Command } from "commander";
import { DevtaskError } from "../errors.js";
import {
  findIndexedWork,
  readGlobalIndex,
  refreshWorkspaceRecentWork,
  registerWorkspace,
  removeWorkspaceFromIndex
} from "../global-index.js";
import { resolveWorkspacePaths } from "../paths.js";
import { printError, printTable, shellQuote } from "./support.js";

export function registerRegistryCommands(program: Command): void {
  const registry = program.command("registry").description("Manage the global devtask workspace index.");

  registry
    .command("list")
    .alias("ls")
    .description("List registered workspaces.")
    .action(() => {
      try {
        const index = readGlobalIndex();
        if (index.workspaces.length === 0) {
          console.log("No registered workspaces");
          return;
        }
        printTable(
          ["ID", "PATH", "LAST SEEN"],
          index.workspaces.map((workspace) => [workspace.id, workspace.path, workspace.lastSeenAt])
        );
      } catch (error) {
        printError(error);
      }
    });

  registry
    .command("add")
    .description("Register the current or specified workspace in the global index.")
    .argument("[path]")
    .action((workspacePath?: string) => {
      try {
        const paths = workspacePath ? resolveWorkspacePaths(workspacePath) : resolveWorkspacePaths();
        const entry = registerWorkspace(paths);
        console.log(`Registered workspace ${entry.id}`);
        console.log(`Path: ${entry.path}`);
      } catch (error) {
        printError(error);
      }
    });

  registry
    .command("remove")
    .description("Remove a workspace from the global index.")
    .argument("<id-or-path>")
    .action((idOrPath: string) => {
      try {
        const removed = removeWorkspaceFromIndex(idOrPath);
        console.log(`Removed workspace ${removed.id}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("recent")
    .description("Show recent work across registered workspaces.")
    .action(async () => {
      try {
        const current = tryResolveWorkspacePaths();
        if (current) {
          await refreshWorkspaceRecentWork(current);
        }
        const index = readGlobalIndex();
        if (index.recentWork.length === 0) {
          console.log("No recent work");
          return;
        }
        printTable(
          ["WORK", "TITLE", "WORKSPACE", "STAGE", "UPDATED"],
          index.recentWork.map((work) => [work.workId, work.title, work.workspaceId, work.stage, work.updatedAt])
        );
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("where")
    .description("Find a work item and print its workspace/artifact locations.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const current = tryResolveWorkspacePaths();
        if (current) {
          await refreshWorkspaceRecentWork(current);
        }
        const work = await findIndexedWork(workId);
        if (!work) {
          throw new DevtaskError(`Work item ${workId} was not found in the global devtask index`);
        }
        console.log(`Work: ${work.workId}`);
        console.log(`Title: ${work.title}`);
        console.log(`Workspace: ${work.workspaceId}`);
        console.log(`Path: ${work.workspacePath}`);
        console.log(`Stage: ${work.stage}`);
        console.log(`Plan: ${work.planPath}`);
        console.log(`Graph: ${work.graphPath}`);
        console.log(`Next: cd ${shellQuote(work.workspacePath)} && devtask work board ${work.workId}`);
      } catch (error) {
        printError(error);
      }
    });
}

function tryResolveWorkspacePaths(): ReturnType<typeof resolveWorkspacePaths> | null {
  try {
    return resolveWorkspacePaths();
  } catch {
    return null;
  }
}
