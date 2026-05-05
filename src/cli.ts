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
import { buildCodexCommand, readConfig, writeConfig } from "./config.js";
import { assertCanMark, parseManualStatus } from "./lifecycle.js";
import { runVerification } from "./verification.js";
import { runCommand, runCommandOrThrow } from "./process-runner.js";
import { runReviewAgent } from "./review-agent.js";

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

  const config = program.command("config").description("Show or update repo-local devtask configuration.");

  config
    .command("show")
    .description("Show repo-local devtask configuration.")
    .action(() => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        console.log(JSON.stringify(readConfig(paths), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("verify")
    .description("Show or replace repo-local verification commands.")
    .argument("[commands...]")
    .action((commands: string[]) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const current = readConfig(paths);

        if (commands.length === 0) {
          if (current.verify.length === 0) {
            console.log("No verification commands configured");
            return;
          }
          for (const command of current.verify) {
            console.log(command);
          }
          return;
        }

        writeConfig(paths, {
          ...current,
          verify: commands
        });
        console.log("Verification commands:");
        for (const command of commands) {
          console.log(`  ${command}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("model")
    .description("Show or update the default Codex model for new tasks.")
    .argument("[model]")
    .action((model?: string) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const current = readConfig(paths);

        if (!model) {
          console.log(current.codex.model ?? "-");
          return;
        }

        writeConfig(paths, {
          ...current,
          codex: {
            ...current.codex,
            model
          }
        });
        console.log(`Default Codex model: ${model}`);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("logs")
    .description("Print or follow the latest task log.")
    .argument("<id>")
    .option("-n, --lines <count>", "Number of trailing lines to print", parsePositiveInteger, 120)
    .option("-f, --follow", "Follow the latest task log")
    .action((id: string, options: { lines: number; follow?: boolean }) => {
      try {
        const paths = resolvePaths();
        getTask(paths, id);
        const logPath = readLatestLogPath(paths, id);
        if (!logPath) {
          console.log(`No logs for task ${id}`);
          return;
        }

        console.log(`Log: ${logPath}`);
        if (options.follow) {
          followFile(logPath, options.lines);
          return;
        }

        console.log(tailFile(logPath, options.lines));
      } catch (error) {
        printError(error);
      }
    });

  const inspectAction = async (id: string): Promise<void> => {
    const paths = resolvePaths();
    const review = await buildTaskReview(paths, getTask(paths, id));
    console.log(`Task: ${review.meta.id}`);
    console.log(`Status: ${review.meta.status}`);
    console.log(`Branch: ${review.meta.branch}`);
    console.log(`Worktree: ${review.meta.worktreePath}`);
    if (review.meta.prUrl) {
      console.log(`PR: ${review.meta.prUrl}`);
    }
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

    if (review.latestVerification) {
      console.log("");
      console.log("Latest check:");
      console.log(`  Status: ${review.latestVerification.status}`);
      console.log(`  Started: ${review.latestVerification.startedAt}`);
      console.log(`  Finished: ${review.latestVerification.finishedAt}`);
      for (const step of review.latestVerification.steps) {
        console.log(`  ${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
      }
    }

    if (review.latestReviewAgent) {
      console.log("");
      console.log("Latest review agent:");
      console.log(`  Status: ${review.latestReviewAgent.status}`);
      console.log(`  Started: ${review.latestReviewAgent.startedAt}`);
      console.log(`  Finished: ${review.latestReviewAgent.finishedAt}`);
      console.log(`  Output: ${review.latestReviewAgent.outputPath}`);
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
  };

  program
    .command("inspect")
    .description("Show task state, latest run/check/review artifacts, result, and worktree changes.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        await inspectAction(id);
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
    .option("--model <model>", "Codex model for this task")
    .option("--cmd <command>", "Worker command to run from the task worktree")
    .option("--max-retries <count>", "Maximum worker retries", parsePositiveInteger)
    .action(
      async (
        id: string,
        options: { goal?: string; branch?: string; model?: string; cmd?: string; maxRetries?: number }
      ) => {
        try {
          const paths = resolvePaths();
          const meta = await createTask(paths, id, { ...options, command: options.cmd });
          console.log(`Created task ${meta.id}`);
          console.log(`Branch: ${meta.branch}`);
          console.log(`Worktree: ${meta.worktreePath}`);
          console.log(`Model: ${meta.model ?? "-"}`);
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
        console.log(`Model: ${meta.model ?? "-"}`);
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
    .command("model")
    .description("Show or update a task Codex model and managed command.")
    .argument("<id>")
    .argument("[model]")
    .action((id: string, model?: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);

        if (!model) {
          console.log(meta.model ?? "-");
          return;
        }

        if (meta.status === "running") {
          throw new DevtaskError(`Task ${id} is running; pause or cancel it before changing the model`);
        }

        const config = readConfig(paths);
        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          model,
          command: buildCodexCommand({ model, fullAuto: config.codex.fullAuto }),
          updatedAt: new Date().toISOString()
        });
        console.log(`Updated model for task ${id}: ${model}`);
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
    .command("mark")
    .description("Manually mark a stopped task as review, approved, done, blocked, or cancelled.")
    .argument("<id>")
    .argument("<status>")
    .action((id: string, statusValue: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        const status = parseManualStatus(statusValue);
        assertCanMark(meta, status);

        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          status,
          supervisorPid: null,
          childPid: null,
          tmuxSession: status === "cancelled" ? null : meta.tmuxSession,
          updatedAt: new Date().toISOString()
        });
        console.log(`Marked task ${id} as ${status}`);
      } catch (error) {
        printError(error);
      }
    });

  const checkAction = async (id: string): Promise<void> => {
    const paths = resolvePaths();
    const meta = getTask(paths, id);
    if (meta.status === "running") {
      throw new DevtaskError(`Task ${id} is running; stop it before checking`);
    }

    const config = readConfig(paths);
    if (config.verify.length === 0) {
      throw new DevtaskError("No check commands configured. Use devtask config verify <command...>");
    }

    const record = await runVerification(paths, meta, config.verify);
    console.log(`Check: ${record.status}`);
    for (const step of record.steps) {
      console.log(`${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
      if (step.exitCode !== 0) {
        if (step.stdout.trim()) console.log(step.stdout.trim());
        if (step.stderr.trim()) console.error(step.stderr.trim());
        process.exit(1);
      }
    }
  };

  program
    .command("check")
    .description("Run configured deterministic check commands in the task worktree.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        await checkAction(id);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("review")
    .description("Run a read-only review agent and store its review artifact.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status === "running") {
          throw new DevtaskError(`Task ${id} is running; stop it before review`);
        }

        const config = readConfig(paths);
        const record = await runReviewAgent(paths, meta, {
          model: meta.model ?? config.codex.model,
          fullAuto: config.codex.fullAuto
        });
        console.log(`Review agent: ${record.status}`);
        console.log(`Output: ${record.outputPath}`);
        if (record.status !== "passed") {
          process.exit(record.exitCode === 0 ? 2 : 1);
        }
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("pr")
    .description("Commit task worktree changes, push branch, and open a GitHub PR.")
    .argument("<id>")
    .option("--title <title>", "PR title")
    .option("--body <body>", "PR body")
    .option("--ready", "Create a ready-for-review PR instead of a draft")
    .action(async (id: string, options: { title?: string; body?: string; ready?: boolean }) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status === "running") {
          throw new DevtaskError(`Task ${id} is running; stop it before opening a PR`);
        }
        if (!["approved", "ci-failed"].includes(meta.status)) {
          throw new DevtaskError(`Task ${id} is ${meta.status}; mark it approved before opening a PR`);
        }

        const prUrl = await createPullRequest(meta, {
          title: options.title ?? meta.id,
          body: options.body ?? defaultPrBody(meta),
          draft: options.ready !== true
        });

        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          status: "pr-open",
          prUrl,
          updatedAt: new Date().toISOString()
        });
        console.log(prUrl);
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("ci")
    .description("Check GitHub PR CI status for a task.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (!meta.prUrl) {
          throw new DevtaskError(`Task ${id} has no PR URL`);
        }

        const result = await runCommand("gh", ["pr", "checks", meta.prUrl], { cwd: meta.worktreePath });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        const status = result.exitCode === 0 ? "ci-passed" : "ci-failed";
        writeTaskMeta(taskMetaPath(paths, id), {
          ...meta,
          status,
          updatedAt: new Date().toISOString()
        });
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
  if (meta.status === "done") {
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

function followFile(filePath: string, lineCount: number): void {
  const child = spawn("tail", ["-n", String(lineCount), "-f", filePath], {
    stdio: "inherit"
  });

  child.once("error", (error) => {
    printError(new DevtaskError(`Failed to follow log: ${error.message}`));
  });
}

async function createPullRequest(
  meta: ReturnType<typeof getTask>,
  options: { title: string; body: string; draft: boolean }
): Promise<string> {
  await runCommandOrThrow("gh", ["--version"], { cwd: meta.worktreePath });
  await runCommandOrThrow("git", ["add", "-A"], { cwd: meta.worktreePath });

  const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: meta.worktreePath });
  if (staged.exitCode !== 0) {
    await runCommandOrThrow("git", ["commit", "-m", options.title], { cwd: meta.worktreePath });
  }

  await runCommandOrThrow("git", ["push", "-u", "origin", meta.branch], { cwd: meta.worktreePath });

  const args = ["pr", "create", "--title", options.title, "--body", options.body];
  if (options.draft) {
    args.push("--draft");
  }

  const result = await runCommandOrThrow("gh", args, { cwd: meta.worktreePath });
  const prUrl = result.stdout.trim().split("\n").at(-1);
  if (!prUrl) {
    throw new DevtaskError("gh did not return a PR URL");
  }
  return prUrl;
}

function defaultPrBody(meta: ReturnType<typeof getTask>): string {
  return [
    `Task: ${meta.id}`,
    "",
    `Branch: ${meta.branch}`,
    `Worktree: ${meta.worktreePath}`,
    "",
    "Created by devtask. Review the task record locally with:",
    "",
    `    devtask inspect ${meta.id}`
  ].join("\n");
}
