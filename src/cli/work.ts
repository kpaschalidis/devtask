import { Command } from "commander";
import { resolveWorkspacePaths } from "../paths.js";
import { getWorkBoard } from "../services/board-service.js";
import {
  checkWork,
  checkWorkCi,
  cleanupWork,
  createWorkPullRequests,
  createManualWork,
  getWork,
  importJiraWork,
  listWork,
  materializeWork,
  planWork,
  readWorkPlanRecord,
  reviewWork,
  specWork,
  verifyWork
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
          rows.map((row) => [row.repo, row.task, row.stage, row.status, row.blocked, row.updated, row.next])
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
    .command("spec")
    .description("Build the work spec by combining global planning with repo-local planning.")
    .argument("<work-id>")
    .option("--refresh", "Rerun repo-local planning even if a repo plan already exists")
    .action(async (workId: string, options: { refresh?: boolean }) => {
      try {
        const result = await specWork(resolveWorkspacePaths(), workId, {
          refresh: options.refresh === true,
          onPlanStart: (start) => {
            console.log(`Global prompt: ${start.promptPath}`);
            console.log(`Global plan: ${start.planPath}`);
            console.log(`Global graph: ${start.graphPath}`);
          },
          onRepoPlanStart: (repoId, start) => {
            console.log(`Repo ${repoId} prompt: ${start.promptPath}`);
            console.log(`Repo ${repoId} plan: ${start.planPath}`);
          }
        });
        console.log("");
        console.log(`Global plan status: ${result.planStatus}`);
        printTable(
          ["REPO", "TASK", "STATUS", "PLAN", "WORKTREE_CHANGED"],
          result.repoPlans.map((task) => [task.repoId, task.taskId, task.status, task.planPath, String(task.worktreeChanged)])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("review")
    .description("Create a durable review packet summarizing repo state and latest artifacts.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await reviewWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "CLEAN", "COMMITS", "PR", "CHECK", "VERIFY", "CI"],
          result.tasks.map((task) => [
            task.repoId,
            task.taskId,
            String(task.clean),
            String(task.commits),
            task.prUrl ?? "-",
            task.latestCheck ?? "-",
            task.latestVerify ?? "-",
            task.latestCi ?? "-"
          ])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("check")
    .description("Run deterministic repo-level checks across repo worktrees.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await checkWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "STATUS", "DETAIL"],
          result.tasks.map((task) => [
            task.repoId,
            task.taskId,
            task.status,
            task.error ?? (task.commands.map((entry) => `${entry.status}:${entry.command}`).join(" | ") || "-")
          ])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("verify")
    .description("Run configured verify commands across repo worktrees.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await verifyWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "STATUS", "DETAIL"],
          result.tasks.map((task) => [
            task.repoId,
            task.taskId,
            task.status,
            task.error ?? (task.commands.map((entry) => `${entry.status}:${entry.command}`).join(" | ") || "-")
          ])
        );
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
          materialization.tasks.map((task) => [task.repoId, task.taskId, task.branch, task.worktreePath])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("pr")
    .description("Create pull requests for repo worktrees when they are publish-ready.")
    .argument("<work-id>")
    .option("--ready", "Create ready pull requests instead of drafts")
    .action(async (workId: string, options: { ready?: boolean }) => {
      try {
        const result = await createWorkPullRequests(resolveWorkspacePaths(), workId, { draft: options.ready !== true });
        printTable(
          ["REPO", "TASK", "STATUS", "PR", "DETAIL"],
          result.tasks.map((task) => [task.repoId, task.taskId, task.status, task.prUrl ?? "-", task.detail])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("ci")
    .description("Check provider CI for repo pull requests.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await checkWorkCi(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "STATUS", "DETAIL", "URL"],
          result.tasks.map((task) => [task.repoId, task.taskId, task.status, task.detail, task.url ?? "-"])
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
              entry.repoId,
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
