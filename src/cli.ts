import { Command } from "commander";
import { DevtaskError } from "./errors.js";
import { resolvePaths } from "./paths.js";
import { createTask, getTask, initializeStore, listTasks } from "./task-store.js";

function printError(error: unknown): never {
  if (error instanceof DevtaskError) {
    console.error(`devtask: ${error.message}`);
    process.exit(1);
  }

  throw error;
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("devtask")
    .description("Local persistent task workers for agent-driven development.")
    .version("1.0.0");

  program
    .command("init")
    .description("Initialize devtask storage in the current git repository.")
    .action(() => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        console.log(`Initialized ${paths.baseDir}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("create")
    .description("Create a task with its own durable state and git worktree.")
    .argument("<id>")
    .option("--goal <goal>", "Initial task goal")
    .option("--branch <branch>", "Branch name to create for this task")
    .option("--max-retries <count>", "Maximum worker retries", (value) => Number.parseInt(value, 10))
    .action(async (id: string, options: { goal?: string; branch?: string; maxRetries?: number }) => {
      try {
        const paths = resolvePaths();
        const meta = await createTask(paths, id, options);
        console.log(`Created task ${meta.id}`);
        console.log(`Branch: ${meta.branch}`);
        console.log(`Worktree: ${meta.worktreePath}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("list")
    .description("List known tasks.")
    .action(() => {
      try {
        const paths = resolvePaths();
        const tasks = listTasks(paths);
        if (tasks.length === 0) {
          console.log("No tasks");
          return;
        }

        console.log("ID\tSTATUS\tBRANCH\tFAILS\tUPDATED");
        for (const task of tasks) {
          console.log(
            `${task.id}\t${task.status}\t${task.branch}\t${task.failCount}/${task.maxRetries}\t${task.updatedAt}`
          );
        }
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("status")
    .description("Show detailed task status.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        console.log(`Task: ${meta.id}`);
        console.log(`Status: ${meta.status}`);
        console.log(`Branch: ${meta.branch}`);
        console.log(`Worktree: ${meta.worktreePath}`);
        console.log(`Task file: ${meta.taskPath}`);
        console.log(`State file: ${meta.statePath}`);
        console.log(`Result file: ${meta.resultPath}`);
        console.log(`Failures: ${meta.failCount}/${meta.maxRetries}`);
        console.log(`Updated: ${meta.updatedAt}`);
      } catch (error) {
        printError(error);
      }
    });

  return program;
}
