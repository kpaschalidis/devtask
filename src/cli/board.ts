import path from "node:path";
import { Command } from "commander";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { getWorkBoard, getWorkspaceBoard } from "../services/board-service.js";
import { generateBoardHtmlReports } from "../services/board-html-service.js";
import { startBoardServer } from "../services/board-server-service.js";
import { printError, printTable } from "./common.js";

export function registerBoardCommands(program: Command): void {
  const board = program.command("board").description("Inspect active work across the current workspace.");

  board
    .action(async () => {
      try {
        const rows = await getWorkspaceBoard(resolveWorkspacePaths());
        if (rows.length === 0) {
          console.log("No work");
          return;
        }
        printTable(
          ["WORK", "TITLE", "SOURCE", "STATUS", "REPOS", "UPDATED", "NEXT"],
          rows.map((row) => [row.workId, row.title, row.source, row.status, row.repos, row.updatedAt, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });

  board
    .command("html")
    .description("Generate a static HTML board report for one or more workspaces.")
    .option("--workspace <workspace-id>", "Generate for one registered workspace")
    .option("--out <dir>", "Output directory", "devtask-board-html")
    .action(async (options: { workspace?: string; out: string }) => {
      try {
        const reports = await generateBoardHtmlReports({
          workspaceId: options.workspace,
          outDir: options.out
        });
        console.log(`Generated ${reports.length} board report${reports.length === 1 ? "" : "s"}`);
        console.log(`Index: ${path.resolve(options.out, "index.html")}`);
        for (const report of reports) {
          console.log(`${report.workspaceId}: ${report.outputPath}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  board
    .command("serve")
    .description("Serve the board as a local live read-only web app.")
    .option("--workspace <workspace-id>", "Serve one registered workspace")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port")
    .action(async (options: { workspace?: string; host: string; port?: string }) => {
      try {
        const server = await startBoardServer({
          workspaceId: options.workspace,
          host: options.host,
          port: options.port ? Number.parseInt(options.port, 10) : undefined
        });
        console.log(`Board server: ${server.url}`);
        console.log("Press Ctrl+C to stop");
      } catch (error) {
        printError(error);
      }
    });

  board
    .command("work")
    .description("Inspect one work item board.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const rows = await getWorkBoard(resolveWorkspacePaths(), workId);
        if (rows.length === 0) {
          console.log("No repo tasks");
          return;
        }
        printTable(
          ["REPO", "TASK", "PHASE", "STATUS", "BLOCKED", "UPDATED", "NEXT"],
          rows.map((row) => [row.repo, row.task, row.phase, row.status, row.blocked, row.updated, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });
}
