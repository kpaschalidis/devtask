import { Command } from "commander";
import { resolveWorkspacePaths } from "../infra/paths.js";
import {
  createWorkspace,
  exportWorkspaceBundle,
  importWorkspaceBundle,
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
    .action(async (options: { register?: boolean }) => {
      try {
        const result = initializeCurrentWorkspace(process.cwd(), { register: options.register !== false });
        console.log(`Initialized workspace ${result.paths.workspaceId ?? "-"}`);
        console.log(`Workspace root: ${result.paths.root}`);
        console.log(`Storage: ${result.paths.baseDir}`);
        if (result.registered) {
          console.log(`Registered workspace ${result.registered.id}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  const workspace = program.command("workspace").description("Manage workspaces and workspace bundles.");

  workspace
    .command("create")
    .description("Create a workspace at the current directory.")
    .requiredOption("--id <workspace-id>")
    .requiredOption("--name <name>")
    .option("--no-register", "Do not add the workspace to the global index")
    .action(async (options: { id: string; name: string; register?: boolean }) => {
      try {
        const result = createWorkspace(process.cwd(), {
          id: options.id,
          name: options.name,
          register: options.register !== false
        });
        console.log(`Created workspace ${options.id}`);
        console.log(`Workspace root: ${result.paths.root}`);
        console.log(`Storage: ${result.paths.baseDir}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("import")
    .description("Import a shareable workspace bundle into the current or specified root.")
    .requiredOption("--file <bundle.zip>")
    .option("--root <path>")
    .option("--no-register", "Do not add the workspace to the global index")
    .action(async (options: { file: string; root?: string; register?: boolean }) => {
      try {
        const result = await importWorkspaceBundle({
          file: options.file,
          root: options.root,
          register: options.register !== false
        });
        console.log(`Imported workspace ${result.paths.workspaceId ?? "-"}`);
        console.log(`Workspace root: ${result.paths.root}`);
        console.log(`Storage: ${result.paths.baseDir}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("export")
    .description("Export a workspace bundle.")
    .requiredOption("--workspace <workspace-id>")
    .requiredOption("--out <file.zip>")
    .action(async (options: { workspace: string; out: string }) => {
      try {
        const result = await exportWorkspaceBundle({
          workspaceId: options.workspace,
          outFile: options.out
        });
        console.log(`Exported workspace ${result.workspace.id}`);
        console.log(`Bundle: ${result.outFile}`);
      } catch (error) {
        printError(error);
      }
    });

  workspace
    .command("show")
    .description("Show the current workspace root.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        console.log(`Workspace: ${paths.root}`);
        console.log(`Workspace ID: ${paths.workspaceId ?? "-"}`);
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
          ["WORK", "TITLE", "WORKSPACE", "STATUS", "UPDATED"],
          items.map((item) => [item.workId, item.title, item.workspaceId, item.status, item.updatedAt])
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
