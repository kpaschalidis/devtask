import { Command } from "commander";
import { resolveWorkspacePaths } from "../paths.js";
import { getWorkBoard } from "../services/board-service.js";
import {
  cleanupWork,
  createManualWork,
  getWork,
  importJiraWork,
  listWork,
  materializeWork,
  planWork,
  readWorkPlanRecord
} from "../services/work-service.js";
import { printError, printTable } from "./common.js";

export function registerWorkCommands(program: Command): void {
  const work = program.command("work").description("Manage work items across multiple repos.");

  work
    .command("create")
    .description("Create a work item from manual input.")
    .argument("<id>")
    .requiredOption("--title <title>")
    .option("--body <body>")
    .action((id: string, options: { title: string; body?: string }) => {
      try {
        const item = createManualWork(resolveWorkspacePaths(), {
          id,
          title: options.title,
          body: options.body ?? null
        });
        console.log(`Created work ${item.id}`);
      } catch (error) {
        printError(error);
      }
    });

  const importCommand = work.command("import").description("Import work from external sources.");
  importCommand
    .command("jira")
    .description("Create a work item from a Jira issue.")
    .argument("<key>")
    .option("--id <work-id>", "Override the local work id")
    .action(async (key: string, options: { id?: string }) => {
      try {
        const workId = options.id ?? key;
        const item = await importJiraWork(resolveWorkspacePaths(), workId, key);
        console.log(`Imported work ${item.id} from Jira ${key}`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("list")
    .description("List work items in the current workspace.")
    .action(() => {
      try {
        const items = listWork(resolveWorkspacePaths());
        if (items.length === 0) {
          console.log("No work");
          return;
        }
        printTable(
          ["ID", "STATUS", "SOURCE", "TITLE", "UPDATED"],
          items.map((item) => [item.id, item.status, item.source.type, item.source.title, item.updatedAt])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("show")
    .description("Show one work item.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        console.log(JSON.stringify(getWork(resolveWorkspacePaths(), workId), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("board")
    .description("Show the repo-level board for one work item.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const rows = await getWorkBoard(resolveWorkspacePaths(), workId);
        if (rows.length === 0) {
          console.log("No repo tasks");
          return;
        }
        printTable(
          ["REPO", "TASK", "STAGE", "STATUS", "BLOCKED", "UPDATED", "NEXT"],
          rows.map((row) => [row.target, row.task, row.stage, row.status, row.blocked, row.updated, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("next")
    .description("Show the next recommended action for one work item.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        const record = readWorkPlanRecord(resolveWorkspacePaths(), workId);
        if (!record) {
          console.log(`Next: devtask work plan ${workId}`);
          return;
        }
        console.log(record.status === "planned" ? `Next: devtask work implement ${workId}` : `Next: devtask work plan ${workId}`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("plan")
    .description("Run the global work planner.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const record = await planWork(resolveWorkspacePaths(), workId, {
          onStart: (start) => {
            console.log(`Prompt: ${start.promptPath}`);
            console.log(`Plan: ${start.planPath}`);
            console.log(`Graph: ${start.graphPath}`);
            console.log(`Output: ${start.outputPath}`);
            console.log(`Command: ${start.command}`);
          },
          onStdout: (chunk) => process.stdout.write(chunk),
          onStderr: (chunk) => process.stderr.write(chunk)
        });
        console.log("");
        console.log(`Plan status: ${record.status}`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("implement")
    .description("Materialize repo-local tasks and worktrees for a work item.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const materialization = await materializeWork(resolveWorkspacePaths(), workId);
        console.log(`Materialized ${materialization.tasks.length} repo task(s)`);
        printTable(
          ["REPO", "TASK", "BRANCH", "WORKTREE"],
          materialization.tasks.map((task) => [task.target, task.taskId, task.branch, task.worktreePath])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("cleanup")
    .description("Clean up worktrees for one work item while preserving history.")
    .argument("<work-id>")
    .option("--dry-run", "Preview cleanup actions")
    .action(async (workId: string, options: { dryRun?: boolean }) => {
      try {
        const result = await cleanupWork(resolveWorkspacePaths(), workId, { dryRun: options.dryRun === true });
        if (result.taskPlans.length > 0) {
          printTable(
            ["REPO", "ACTIONS", "BLOCKERS"],
            result.taskPlans.map((entry) => [
              entry.target,
              String(entry.plan.actions.length),
              entry.plan.blockers.join("; ") || "-"
            ])
          );
        }
        if (result.actions.length > 0) {
          console.log("");
          for (const action of result.actions) {
            console.log(`- ${action}`);
          }
        }
        if (result.blockers.length > 0) {
          console.log("");
          console.log("Blockers:");
          for (const blocker of result.blockers) {
            console.log(`- ${blocker}`);
          }
        }
      } catch (error) {
        printError(error);
      }
    });
}
