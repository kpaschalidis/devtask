import { Command } from "commander";
import { DevtaskError } from "../errors.js";
import { planMarkdownPath, resolvePaths, taskMetaPath } from "../paths.js";
import { writeTaskMeta } from "../meta.js";
import { terminateProcessGroup } from "../processes.js";
import { createTask, getTask, listTasks } from "../task-store.js";
import { buildTaskReview, readLatestLogPath } from "../task-inspection.js";
import { attachTmuxSession, killTmuxSession, tmuxSessionExists } from "../tmux.js";
import { buildCodexCommand, readConfig } from "../config.js";
import { parseManualStatus } from "../lifecycle.js";
import { cleanupTask, planTaskCleanup, type CleanupOptions } from "../cleanup.js";
import { assertReviewReady } from "../stage-policy.js";
import { buildBoardRow, recommendNextAction } from "../workflow.js";
import {
  advanceTask,
  approveTask,
  checkCiForTask,
  checkTask,
  commitTask,
  createFixRequest,
  followFile,
  killTaskStageSessions,
  markTask,
  normalizeCleanupOptions,
  openPrForTask,
  parsePositiveInteger,
  planTask,
  printCleanupPlan,
  printError,
  printNextAction,
  printStartedWorker,
  printTable,
  resolveAttachSession,
  resolveRunRuntime,
  reviewTask,
  startStageSessionIfRequested,
  startWorker,
  steerTask,
  tailFile,
  type PrOptions
} from "./support.js";

export function registerTaskCommands(program: Command): void {
  const task = program.command("task").description("Advanced repo-local task commands.");

  task
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
    printTaskReview(review);
  };

  const printTaskReview = (review: Awaited<ReturnType<typeof buildTaskReview>>): void => {
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

    console.log("");
    console.log("Plan:");
    console.log(`  File: ${review.planPath}`);
    console.log(`  Exists: ${review.hasPlan ? "yes" : "no"}`);
    if (review.latestPlan) {
      console.log(`  Status: ${review.latestPlan.status}`);
      console.log(`  Finished: ${review.latestPlan.finishedAt}`);
      console.log(`  Output: ${review.latestPlan.outputPath}`);
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

  task
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

  task
    .command("plan")
    .description("Run a planning-only agent and store the plan artifact.")
    .argument("<id>")
    .option("--attachable", "Run the planning agent inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        if (startStageSessionIfRequested(paths, id, "plan", ["task", "plan", id, "--plain"], options)) {
          return;
        }
        await planTask(paths, id);
      } catch (error) {
        printError(error);
      }
    });

  task
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

  task
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

  task
    .command("board")
    .description("Show all tasks with latest check/review/PR state and next command.")
    .action(async () => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const tasks = listTasks(paths);
        if (tasks.length === 0) {
          console.log("No tasks");
          return;
        }

        const rows = [];
        for (const task of tasks) {
          rows.push(buildBoardRow(await buildTaskReview(paths, getTask(paths, task.id)), config));
        }

        printTable(
          ["ID", "STAGE", "STATUS", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [row.id, row.stage, row.status, row.check, row.review, row.pr, row.updated, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("next")
    .description("Recommend the next workflow action for one task or all tasks.")
    .argument("[id]")
    .action(async (id?: string) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const ids = id ? [id] : listTasks(paths).map((task) => task.id);
        if (ids.length === 0) {
          console.log("No tasks");
          return;
        }

        for (const taskId of ids) {
          const review = await buildTaskReview(paths, getTask(paths, taskId));
          printNextAction(taskId, recommendNextAction(review, config));
        }
      } catch (error) {
        printError(error);
      }
    });

  task
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
        console.log(`Plan file: ${planMarkdownPath(paths, meta.id)}`);
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

  task
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

  task
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

  task
    .command("mark")
    .description("Manually mark a stopped task as review, approved, done, blocked, or cancelled.")
    .argument("<id>")
    .argument("<status>")
    .action((id: string, statusValue: string) => {
      try {
        const paths = resolvePaths();
        const status = parseManualStatus(statusValue);
        markTask(paths, id, status);
        console.log(`Marked task ${id} as ${status}`);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("approve")
    .description("Approve a stopped task after policy checks.")
    .argument("<id>")
    .option("--force", "Approve even when checks or review are missing or failing")
    .action(async (id: string, options: { force?: boolean }) => {
      try {
        const paths = resolvePaths();
        const result = await approveTask(paths, id, { force: options.force === true });
        console.log(`Approved task ${id}`);
        if (result) {
          console.log(result);
        }
      } catch (error) {
        printError(error);
      }
    });

  const checkAction = async (id: string): Promise<void> => {
    const paths = resolvePaths();
    await checkTask(paths, id, { exitOnFailure: true });
  };

  const reviewAction = async (id: string): Promise<void> => {
    const paths = resolvePaths();
    await reviewTask(paths, id, { exitOnFindings: true });
  };

  const prAction = async (
    id: string,
    options: PrOptions
  ): Promise<void> => {
    const paths = resolvePaths();
    await openPrForTask(paths, id, options);
  };

  const commitAction = async (id: string, options: { message?: string }): Promise<void> => {
    const paths = resolvePaths();
    await commitTask(paths, id, options);
  };

  const ciAction = async (id: string): Promise<void> => {
    const paths = resolvePaths();
    await checkCiForTask(paths, id);
  };

  task
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

  task
    .command("review")
    .description("Run a read-only review agent and store its review artifact.")
    .argument("<id>")
    .option("--attachable", "Run the review agent inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        assertReviewReady(paths, getTask(paths, id), readConfig(paths));
        if (startStageSessionIfRequested(paths, id, "review", ["task", "review", id, "--plain"], options)) {
          return;
        }
        await reviewAction(id);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("fix")
    .description("Run a fix agent from an explicit failed-stage artifact.")
    .argument("<id>")
    .option("--from <stage>", "Failed stage to fix", "check")
    .option("--attachable", "Run the fix worker inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run the fix worker as a plain detached background process")
    .action((id: string, options: { from: string; attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        const request = createFixRequest(paths, id, options.from);
        const started = startWorker(paths, id, { ...resolveRunRuntime(paths, options), fix: true });
        printStartedWorker(id, started, "Fixing");
        console.log(`Fix: ${request.source}:${request.fixId}`);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("commit")
    .description("Commit current task worktree changes without pushing or opening a PR.")
    .argument("<id>")
    .option("-m, --message <message>", "Commit message")
    .action(async (id: string, options: { message?: string }) => {
      try {
        await commitAction(id, options);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("pr")
    .description("Push existing task branch commits and open a provider PR or MR.")
    .argument("<id>")
    .option("--title <title>", "PR title")
    .option("--body <body>", "PR body")
    .option("--draft", "Create a draft PR")
    .option("--ready", "Create a ready-for-review PR instead of a draft")
    .action(async (id: string, options: PrOptions) => {
      try {
        await prAction(id, options);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("ci")
    .description("Check provider CI status for a task PR or MR.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        await ciAction(id);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("cleanup")
    .description("Remove a task worktree and metadata.")
    .argument("<id>")
    .option("--dry-run", "Print cleanup plan without deleting anything")
    .option("--force", "Clean up even when the task is running or worktree is dirty")
    .option("--keep-worktree", "Keep the task worktree")
    .option("--keep-metadata", "Keep the task metadata directory")
    .action(async (id: string, options: CleanupOptions) => {
      try {
        const paths = resolvePaths();
        const cleanupOptions = normalizeCleanupOptions(options);
        const plan = options.dryRun
          ? await planTaskCleanup(paths, id, cleanupOptions)
          : await cleanupTask(paths, id, cleanupOptions);
        printCleanupPlan(id, plan);
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("advance")
    .description("Run the next safe workflow step for a task, stopping at human approval.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const review = await buildTaskReview(paths, getTask(paths, id));
        const next = recommendNextAction(review, config);

        if (!next.automatic) {
          printNextAction(id, next);
          return;
        }

        switch (next.kind) {
          case "plan":
            await planTask(paths, id);
            return;
          case "run": {
            printStartedWorker(id, startWorker(paths, id, resolveRunRuntime(paths, {})), "Running");
            return;
          }
          case "continue": {
            const meta = getTask(paths, id);
            printStartedWorker(id, startWorker(paths, id, meta.tmuxSession ? { tmux: true } : resolveRunRuntime(paths, {})), "Continuing");
            return;
          }
          case "check":
            await checkAction(id);
            return;
          case "review":
            await reviewAction(id);
            return;
          case "pr":
            await prAction(id, {});
            return;
          case "ci":
            await ciAction(id);
            return;
          default:
            printNextAction(id, next);
        }
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("run")
    .description("Run or continue a task worker in the background.")
    .argument("<id>")
    .option("--attachable", "Run the worker inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run the worker as a plain detached background process")
    .action((id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        const started = startWorker(paths, id, resolveRunRuntime(paths, options));
        printStartedWorker(id, started, "Running");
      } catch (error) {
        printError(error);
      }
    });

  task
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

  task
    .command("continue")
    .description("Continue a paused or stopped task worker.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        if (meta.status === "running") {
          throw new DevtaskError(`Task ${id} is already running`);
        }
        if (meta.status === "done") {
          throw new DevtaskError(`Task ${id} is done and cannot be continued`);
        }

        const started = startWorker(paths, id, meta.tmuxSession ? { tmux: true } : resolveRunRuntime(paths, {}));
        printStartedWorker(id, started, "Continuing");
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("steer")
    .description("Send live feedback to a running attachable task session.")
    .argument("<id>")
    .argument("[message...]")
    .option("-f, --file <path>", "Read feedback from a file")
    .option("-n, --lines <count>", "Capture this many lines after sending", parsePositiveInteger, 20)
    .option("--stage <stage>", "Steer a lifecycle stage session such as run, fix, plan, or review")
    .action((id: string, messageParts: string[], options: { file?: string; lines: number; stage?: string }) => {
      try {
        const paths = resolvePaths();
        steerTask(paths, id, {
          messageParts,
          file: options.file,
          lines: options.lines,
          stage: options.stage
        });
      } catch (error) {
        printError(error);
      }
    });

  task
    .command("attach")
    .description("Attach to a task tmux session.")
    .argument("<id>")
    .option("--stage <stage>", "Attach to a lifecycle stage session such as run, fix, plan, or review")
    .action((id: string, options: { stage?: string }) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        const session = resolveAttachSession(paths, meta, options.stage);
        if (!tmuxSessionExists(session)) {
          const status = meta.supervisorPid || meta.childPid ? `status: ${meta.status}, supervisor: ${meta.supervisorPid ?? "-"}` : `status: ${meta.status}`;
          throw new DevtaskError(`No attachable session for ${id} (${status}).`);
        }
        attachTmuxSession(session);
      } catch (error) {
        printError(error);
      }
    });

  task
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
        killTaskStageSessions(paths, id);
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

}
