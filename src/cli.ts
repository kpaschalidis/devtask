import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DevtaskError } from "./errors.js";
import { resolvePaths, taskMetaPath } from "./paths.js";
import { writeTaskMeta } from "./meta.js";
import { isProcessAlive, terminateProcessGroup } from "./processes.js";
import { createTask, getTask, initializeStore, listTasks } from "./task-store.js";
import { buildTaskReview, inspectTaskHealth, readLatestLogPath } from "./task-inspection.js";
import { attachTmuxSession, killTmuxSession, startTmuxSession, tmuxSessionName } from "./tmux.js";

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
    .command("logs")
    .description("Print the latest task log.")
    .argument("<id>")
    .option("-n, --lines <count>", "Number of trailing lines to print", parsePositiveInteger, 120)
    .action((id: string, options: { lines: number }) => {
      try {
        const paths = resolvePaths();
        getTask(paths, id);
        const logPath = readLatestLogPath(paths, id);
        if (!logPath) {
          console.log(`No logs for task ${id}`);
          return;
        }

        console.log(`Log: ${logPath}`);
        console.log(tailFile(logPath, options.lines));
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("review")
    .description("Summarize task state, latest run, result, and worktree changes.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolvePaths();
        const review = await buildTaskReview(paths, getTask(paths, id));
        console.log(`Task: ${review.meta.id}`);
        console.log(`Status: ${review.meta.status}`);
        console.log(`Branch: ${review.meta.branch}`);
        console.log(`Worktree: ${review.meta.worktreePath}`);
        console.log(`Failures: ${review.meta.failCount}/${review.meta.maxRetries}`);

        if (review.latestRun) {
          console.log("");
          console.log("Latest run:");
          console.log(`  Status: ${review.latestRun.status}`);
          console.log(`  Exit code: ${review.latestRun.exitCode ?? "-"}`);
          console.log(`  Started: ${review.latestRun.startedAt}`);
          console.log(`  Finished: ${review.latestRun.finishedAt}`);
          console.log(`  Log: ${review.latestRun.logPath}`);
        }

        console.log("");
        console.log("Changed files:");
        if (review.changedFiles.length === 0) {
          console.log("  none");
        } else {
          for (const file of review.changedFiles) {
            console.log(`  ${file}`);
          }
        }

        console.log("");
        console.log("Result:");
        console.log(JSON.stringify(review.result, null, 2));
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("doctor")
    .description("Inspect task metadata for stale process and filesystem state.")
    .action(() => {
      try {
        const paths = resolvePaths();
        const issues = listTasks(paths).flatMap((summary) => inspectTaskHealth(getTask(paths, summary.id)));

        if (issues.length === 0) {
          console.log("No issues found");
          return;
        }

        for (const issue of issues) {
          console.log(`${issue.taskId}: ${issue.message}`);
        }
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
    .option("--cmd <command>", "Worker command to run from the task worktree")
    .option("--max-retries <count>", "Maximum worker retries", parsePositiveInteger)
    .action(
      async (id: string, options: { goal?: string; branch?: string; cmd?: string; maxRetries?: number }) => {
        try {
          const paths = resolvePaths();
          const meta = await createTask(paths, id, { ...options, command: options.cmd });
          console.log(`Created task ${meta.id}`);
          console.log(`Branch: ${meta.branch}`);
          console.log(`Worktree: ${meta.worktreePath}`);
        } catch (error) {
          printError(error);
        }
      }
    );

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
        console.log(`Command: ${meta.command}`);
        console.log(`Supervisor PID: ${meta.supervisorPid ?? "-"}`);
        console.log(`Child PID: ${meta.childPid ?? "-"}`);
        console.log(`tmux: ${meta.tmuxSession ?? "-"}`);
        console.log(`Failures: ${meta.failCount}/${meta.maxRetries}`);
        console.log(`Updated: ${meta.updatedAt}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("command")
    .description("Show or update a task worker command.")
    .argument("<id>")
    .argument("[command...]")
    .action((id: string, commandParts: string[]) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        const command = commandParts.join(" ").trim();

        if (!command) {
          console.log(meta.command);
          return;
        }

        if (meta.status === "running") {
          throw new DevtaskError(`Task ${id} is running; pause or cancel it before changing the command`);
        }

        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          command,
          updatedAt: new Date().toISOString()
        });
        console.log(`Updated command for task ${id}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("start")
    .description("Start or resume a task worker in the background.")
    .argument("<id>")
    .option("--tmux", "Run the worker inside a tmux session")
    .action((id: string, options: { tmux?: boolean }) => {
      try {
        const paths = resolvePaths();
        const started = startWorker(paths, id, { tmux: options.tmux === true });
        console.log(`Started task ${id}`);
        if (started.tmuxSession) {
          console.log(`tmux: ${started.tmuxSession}`);
          return;
        }
        console.log(`Supervisor PID: ${started.pid ?? "-"}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("pause")
    .description("Pause a task after its current run finishes.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status !== "running") {
          throw new DevtaskError(`Task ${id} is ${meta.status}, not running`);
        }
        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          status: "paused",
          updatedAt: new Date().toISOString()
        });
        console.log(`Paused task ${id}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("resume")
    .description("Resume a paused task worker.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status !== "paused") {
          throw new DevtaskError(`Task ${id} is ${meta.status}, not paused`);
        }

        const started = startWorker(paths, id, { tmux: meta.tmuxSession !== null });
        console.log(`Resumed task ${id}`);
        if (started.tmuxSession) {
          console.log(`tmux: ${started.tmuxSession}`);
          return;
        }
        console.log(`Supervisor PID: ${started.pid ?? "-"}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("attach")
    .description("Attach to a task tmux session.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        const session = meta.tmuxSession ?? tmuxSessionName(paths, id);
        attachTmuxSession(session);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("cancel")
    .description("Cancel a task and terminate its supervised process group.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status === "done") {
          throw new DevtaskError(`Task ${id} is done and cannot be cancelled`);
        }
        if (meta.status === "cancelled") {
          console.log(`Task ${id} is already cancelled`);
          return;
        }
        terminateProcessGroup(meta.supervisorPid);
        if (meta.tmuxSession) {
          killTmuxSession(meta.tmuxSession);
        }
        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          status: "cancelled",
          supervisorPid: null,
          childPid: null,
          tmuxSession: null,
          updatedAt: new Date().toISOString()
        });
        console.log(`Cancelled task ${id}`);
      } catch (error) {
        printError(error);
      }
    });

  return program;
}

interface StartedWorker {
  pid: number | null;
  tmuxSession: string | null;
}

function startWorker(paths: ReturnType<typeof resolvePaths>, id: string, options: { tmux?: boolean } = {}): StartedWorker {
  const meta = getTask(paths, id);
  if (isProcessAlive(meta.supervisorPid)) {
    throw new DevtaskError(`Task ${id} is already supervised by PID ${meta.supervisorPid}`);
  }
  if (["done", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${id} is ${meta.status} and cannot be started`);
  }

  const next = {
    ...meta,
    status: "running" as const,
    supervisorPid: null,
    childPid: null,
    tmuxSession: options.tmux ? tmuxSessionName(paths, id) : null,
    failCount: 0,
    updatedAt: new Date().toISOString()
  };
  writeTaskMeta(taskMetaPath(paths, id), next);

  const workerPath = fileURLToPath(new URL("./bin/devtask-worker.js", import.meta.url));
  const workerCommand = [process.execPath, workerPath, id, "--root", paths.root];

  if (options.tmux) {
    if (!next.tmuxSession) {
      throw new DevtaskError("Unable to derive tmux session name");
    }

    startTmuxSession(next.tmuxSession, workerCommand, paths.root);
    return { pid: null, tmuxSession: next.tmuxSession };
  }

  const child = spawn(process.execPath, [workerPath, id, "--root", paths.root], {
    cwd: paths.root,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  writeTaskMeta(taskMetaPath(paths, id), {
    ...next,
    supervisorPid: child.pid ?? null,
    tmuxSession: null,
    updatedAt: new Date().toISOString()
  });

  return { pid: child.pid ?? null, tmuxSession: null };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DevtaskError("Expected a positive integer");
  }
  return parsed;
}

function tailFile(filePath: string, lineCount: number): string {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").slice(-lineCount).join("\n");
}
