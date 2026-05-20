import { Command } from "commander";
import { resolveWorkspacePaths } from "../paths.js";
import {
  initializeCurrentWorkspace,
  listRecentWorkspaceWork,
  listRegisteredWorkspaces,
  locateWork,
  registerWorkspacePath,
  removeRegisteredWorkspace
} from "../services/workspace-service.js";
import { printError, printTable, shellQuote } from "./common.js";

export function registerWorkspaceCommands(program: Command): void {
  program
    .command("init")
    .description("Initialize devtask in the current directory as a workspace.")
    .option("--no-register", "Do not add the workspace to the global index")
    .action((options: { register?: boolean }) => {
      try {
        const result = initializeCurrentWorkspace(process.cwd(), { register: options.register !== false });
        console.log(`Initialized workspace at ${result.paths.baseDir}`);
        if (result.registered) {
          console.log(`Registered workspace ${result.registered.id}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  const workspace = program.command("workspace").description("Manage workspaces and workspace discovery.");

  workspace
    .command("show")
    .description("Show the current workspace root.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        console.log(`Workspace: ${paths.root}`);
        console.log(`Storage: ${paths.baseDir}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("list")
    .description("List registered workspaces.")
    .action(() => {
      try {
        const items = listRegisteredWorkspaces();
        if (items.length === 0) {
          console.log("No registered workspaces");
          return;
        }
        printTable(["ID", "PATH", "LAST SEEN"], items.map((item) => [item.id, item.path, item.lastSeenAt]));
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("add")
    .description("Register the current or specified workspace.")
    .argument("[path]")
    .action((workspacePath?: string) => {
      try {
        const entry = registerWorkspacePath(workspacePath);
        console.log(`Registered workspace ${entry.id}`);
        console.log(`Path: ${entry.path}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("remove")
    .description("Remove a workspace from the global index.")
    .argument("<id-or-path>")
    .action((idOrPath: string) => {
      try {
        const removed = removeRegisteredWorkspace(idOrPath);
        console.log(`Removed workspace ${removed.id}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("recent")
    .description("Show recent work across registered workspaces.")
    .action(async () => {
      try {
        const items = await listRecentWorkspaceWork();
        if (items.length === 0) {
          console.log("No recent work");
          return;
        }
        printTable(
          ["WORK", "TITLE", "WORKSPACE", "STAGE", "UPDATED"],
          items.map((item) => [item.workId, item.title, item.workspaceId, item.stage, item.updatedAt])
        );
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("where")
    .description("Find a work item in the registered workspace index.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const item = await locateWork(workId);
        if (!item) {
          console.log(`Work ${workId} was not found`);
          return;
        }
        console.log(`Work: ${item.workId}`);
        console.log(`Title: ${item.title}`);
        console.log(`Workspace: ${item.workspacePath}`);
        console.log(`Plan: ${item.planPath}`);
        console.log(`Graph: ${item.graphPath}`);
        console.log(`Next: cd ${shellQuote(item.workspacePath)} && devtask work board ${shellQuote(item.workId)}`);
      } catch (error) {
        printError(error);
      }
    });
}
