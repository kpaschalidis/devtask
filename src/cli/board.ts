import { Command } from "commander";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { getWorkBoard, getWorkspaceBoard } from "../services/board-service.js";
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
