import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import { resolvePaths, resolveWorkspacePaths, resolveWorkspacePathsForInit, scriptsDir, taskMetaPath } from "./paths.js";
import { writeTaskMeta } from "./meta.js";
import { isProcessAlive, terminateProcessGroup } from "./processes.js";
import { createTask, getTask, initializeStore, initializeWorkspace, listTasks } from "./task-store.js";
import { buildTaskReview, inspectTaskHealth, readLatestLogPath } from "./task-inspection.js";
import { attachTmuxSession, killTmuxSession, startTmuxSession, tmuxSessionName } from "./tmux.js";
import { buildCodexCommand, readConfig, writeConfig } from "./config.js";
import { assertCanMark, parseManualStatus } from "./lifecycle.js";
import { runVerification } from "./verification.js";
import { runCommand, runCommandOrThrow } from "./process-runner.js";
import { runReviewAgent } from "./review-agent.js";
import { buildBoardRow, recommendNextAction, type NextAction } from "./workflow.js";
import { addRepoToGroup, createGroup, deleteGroup, getGroup, groupDir, listGroups, removeRepoFromGroup } from "./group-store.js";
import { cleanupTask, planTaskCleanup, type CleanupOptions, type CleanupPlan } from "./cleanup.js";
import { assertValidTaskId } from "./task-id.js";
import {
  countBranchCommits,
  createProviderPullRequest,
  detectRemoteInfo,
  hasUncommittedChanges,
  preflightScmForPullRequest,
  type ScmPreflight
} from "./scm.js";

interface PrOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  ready?: boolean;
}

function printError(error: unknown): never {
  if (error instanceof DevtaskError) {
    console.error(`devtask: ${error.message}`);
    process.exit(1);
  }

  throw error;
}

function printNonFatalError(error: unknown): void {
  if (error instanceof DevtaskError) {
    console.error(`devtask: ${error.message}`);
    return;
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
    .description("Initialize devtask storage in the current git repository or workspace.")
    .option("--workspace", "Initialize a non-git workspace for groups and helper scripts")
    .action((options: { workspace?: boolean }) => {
      try {
        if (options.workspace) {
          const paths = resolveWorkspacePathsForInit();
          initializeWorkspace(paths);
          console.log(`Initialized workspace ${paths.baseDir}`);
          return;
        }

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
    .command("check")
    .description("Show or replace repo-local check commands.")
    .argument("[commands...]")
    .action((commands: string[]) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const current = readConfig(paths);

        if (commands.length === 0) {
          if (current.verify.length === 0) {
            console.log("No check commands configured");
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
        console.log("Check commands:");
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

  const scripts = program.command("scripts").description("Install and run packaged devtask helper scripts.");

  scripts
    .command("list")
    .description("List packaged helper scripts.")
    .action(() => {
      try {
        for (const script of listTemplateScripts()) {
          console.log(script);
        }
      } catch (error) {
        printError(error);
      }
    });

  scripts
    .command("install")
    .description("Install packaged helper scripts into .devtask/scripts.")
    .option("--force", "Overwrite existing installed scripts")
    .action((options: { force?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const installed = installTemplateScripts(paths, { force: options.force === true });
        for (const filePath of installed) {
          console.log(filePath);
        }
      } catch (error) {
        printError(error);
      }
    });

  scripts
    .command("show")
    .description("Print a packaged helper script.")
    .argument("<name>")
    .action((name: string) => {
      try {
        process.stdout.write(fs.readFileSync(templateScriptPath(name), "utf8"));
      } catch (error) {
        printError(error);
      }
    });

  scripts
    .command("run")
    .description("Run an installed helper script from .devtask/scripts.")
    .argument("<name>")
    .argument("[args...]")
    .allowUnknownOption(true)
    .action((name: string, args: string[]) => {
      try {
        const paths = resolveWorkspacePaths();
        const scriptPath = installedScriptPath(paths, name);
        if (!fs.existsSync(scriptPath)) {
          throw new DevtaskError(`Script ${name} is not installed. Run devtask scripts install first.`);
        }
        const child = spawn(scriptPath, args, {
          cwd: paths.root,
          stdio: "inherit",
          env: process.env
        });
        child.once("error", (error) => {
          printError(new DevtaskError(`Failed to run script ${name}: ${error.message}`));
        });
        child.once("exit", (code) => {
          process.exit(code ?? 1);
        });
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

  const doctor = program.command("doctor").description("Inspect local devtask setup and task health.");

  doctor
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

  doctor
    .command("auth")
    .description("Inspect SCM provider and auth readiness for the current repository.")
    .action(async () => {
      try {
        const paths = resolvePaths();
        const remote = await detectRemoteInfo(paths.root);
        const preflight = await preflightScmForPullRequest(paths.root, { draft: false });
        printTable(
          ["PROVIDER", "AUTH", "CLEAN", "COMMITS", "REMOTE"],
          [[remote.provider, preflight.auth, preflight.clean ? "ok" : "dirty", String(preflight.commits), remote.remoteUrl]]
        );
        if (preflight.authDetail) {
          console.log("");
          console.log(preflight.authDetail);
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
          ["ID", "STATUS", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [row.id, row.status, row.check, row.review, row.pr, row.updated, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });

  program
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

  const group = program.command("group").description("Coordinate multiple repo-local tasks as one feature group.");

  group
    .command("create")
    .description("Create a multi-repo task group in the current repository or workspace.")
    .argument("<id>")
    .option("--goal <goal>", "Group goal")
    .option("--goal-file <path>", "Read the group goal from a Markdown/text file")
    .option("--repo <spec>", "Create and add a repo task as name=path:task-id", collectOption, [])
    .action(async (id: string, options: { goal?: string; goalFile?: string; repo: string[] }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const goal = readGroupGoal(paths, options);
        const repoSpecs = parseGroupCreateRepoSpecs(options.repo);
        const plannedRepos = preflightGroupCreateRepos(paths, id, repoSpecs);
        const created = createGroup(paths, id, { goal });
        console.log(`Created group ${created.id}`);
        console.log(`Goal: ${created.goal ?? "-"}`);

        if (repoSpecs.length === 0) {
          return;
        }

        for (const repo of plannedRepos) {
          initializeStore(repo.paths);
          const meta = await createTask(repo.paths, repo.taskId, {
            goal: buildGroupRepoGoal(id, goal, repo.name)
          });
          const updated = addRepoToGroup(paths, id, {
            name: repo.name,
            repoPath: repo.paths.root,
            taskId: meta.id
          });
          console.log(`Added ${repo.name} to group ${updated.id}`);
          console.log(`Repo: ${repo.paths.root}`);
          console.log(`Task: ${meta.id}`);
          console.log(`Worktree: ${meta.worktreePath}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("add")
    .description("Add a repository to a group and create its repo-local task.")
    .argument("<id>")
    .argument("<repo-name>")
    .argument("<repo-path>")
    .requiredOption("--task <task-id>", "Task id to create in the target repository")
    .option("--goal <goal>", "Repo-local task goal")
    .action(async (id: string, repoName: string, repoPath: string, options: { task: string; goal?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const existingGroup = getGroup(paths, id);
        if (existingGroup.repos.some((repo) => repo.name === repoName)) {
          throw new DevtaskError(`Group ${id} already has repo ${repoName}`);
        }
        const repoPaths = resolveRepoPathForGroup(repoPath);
        if (existingGroup.repos.some((repo) => repo.path === repoPaths.root)) {
          throw new DevtaskError(`Group ${id} already has repo path ${repoPaths.root}`);
        }
        initializeStore(repoPaths);
        const meta = await createTask(repoPaths, options.task, {
          goal: options.goal ?? `Group ${id}: ${repoName}`
        });
        const updated = addRepoToGroup(paths, id, {
          name: repoName,
          repoPath: repoPaths.root,
          taskId: meta.id
        });
        console.log(`Added ${repoName} to group ${updated.id}`);
        console.log(`Repo: ${repoPaths.root}`);
        console.log(`Task: ${meta.id}`);
        console.log(`Worktree: ${meta.worktreePath}`);
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("remove")
    .description("Remove a repository from a group.")
    .argument("<id>")
    .argument("<repo-name>")
    .option("--delete-task", "Also delete the repo-local task metadata directory")
    .action((id: string, repoName: string, options: { deleteTask?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const updated = removeRepoFromGroup(paths, id, repoName, { deleteTask: options.deleteTask === true });
        console.log(`Removed ${repoName} from group ${updated.id}`);
        if (options.deleteTask) {
          console.log("Deleted repo-local task metadata");
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("cleanup")
    .description("Remove every repo task worktree/metadata in a group, then remove group metadata.")
    .argument("<id>")
    .option("--dry-run", "Print cleanup plan without deleting anything")
    .option("--force", "Clean up even when a task is running or worktree is dirty")
    .option("--keep-worktrees", "Keep repo task worktrees")
    .option("--keep-metadata", "Keep repo task metadata directories")
    .option("--keep-group", "Keep group metadata")
    .action(async (id: string, options: CleanupOptions & { keepGroup?: boolean; keepWorktrees?: boolean; keepMetadata?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        const cleanupOptions = normalizeCleanupOptions(options);
        const plans: Array<{ repo: string; plan: CleanupPlan }> = [];

        for (const repo of groupData.repos) {
          const repoPaths = resolvePaths(repo.path);
          const plan = await planTaskCleanup(repoPaths, repo.taskId, cleanupOptions);
          plans.push({ repo: repo.name, plan });
        }

        const blockers = plans.flatMap(({ repo, plan }) =>
          plan.blockers.map((blocker) => `${repo}/${plan.taskId}: ${blocker}`)
        );
        for (const { repo, plan } of plans) {
          printCleanupPlan(`${repo}/${plan.taskId}`, plan);
        }

        const groupAction = `remove group metadata ${groupDir(paths, id)}`;
        console.log(`${id}`);
        console.log(`  ${options.keepGroup ? "SKIP" : "PLAN"} ${groupAction}`);

        if (blockers.length > 0 && !options.force) {
          throw new DevtaskError(`Group cleanup refused:\n${blockers.map((blocker) => `  - ${blocker}`).join("\n")}\nUse --force to override.`);
        }

        if (options.dryRun) {
          return;
        }

        for (const repo of groupData.repos) {
          const repoPaths = resolvePaths(repo.path);
          await cleanupTask(repoPaths, repo.taskId, cleanupOptions);
        }
        if (!options.keepGroup) {
          deleteGroup(paths, id);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("list")
    .description("List task groups in the current repository or workspace.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        const groups = listGroups(paths);
        if (groups.length === 0) {
          console.log("No groups");
          return;
        }

        printTable(
          ["ID", "REPOS", "UPDATED", "GOAL"],
          groups.map((item) => [item.id, String(item.repos.length), item.updatedAt, item.goal ?? "-"])
        );
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("show")
    .description("Show group metadata.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        console.log(JSON.stringify(getGroup(paths, id), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("inspect")
    .description("Inspect every repo task in a group.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        if (groupData.repos.length === 0) {
          console.log("No repos in group");
          return;
        }

        for (const [index, repo] of groupData.repos.entries()) {
          if (index > 0) {
            console.log("");
          }
          console.log(`${repo.name}/${repo.taskId}`);
          const repoPaths = resolvePaths(repo.path);
          const review = await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId));
          printTaskReview(review);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("logs")
    .description("Print or follow logs for repo tasks in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only show logs for one repo")
    .option("-n, --lines <count>", "Number of trailing lines to print", parsePositiveInteger, 120)
    .option("-f, --follow", "Follow one repo task log")
    .action((id: string, options: { repo?: string; lines: number; follow?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        const repos = options.repo ? groupData.repos.filter((repo) => repo.name === options.repo) : groupData.repos;
        if (repos.length === 0) {
          throw new DevtaskError(options.repo ? `Group ${id} does not have repo ${options.repo}` : "No repos in group");
        }
        if (options.follow && repos.length !== 1) {
          throw new DevtaskError("Use --repo when following group logs");
        }

        for (const [index, repo] of repos.entries()) {
          if (index > 0) {
            console.log("");
          }
          printGroupLog(repo.name, repo.path, repo.taskId, { lines: options.lines, follow: options.follow === true });
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("check")
    .description("Run configured checks for every repo task in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only check one repo")
    .action(async (id: string, options: { repo?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        let failed = false;

        for (const [index, repo] of repos.entries()) {
          if (index > 0) {
            console.log("");
          }
          console.log(`${repo.name}/${repo.taskId}`);
          const repoPaths = resolvePaths(repo.path);
          try {
            await checkTask(repoPaths, repo.taskId, { exitOnFailure: false });
          } catch (error) {
            failed = true;
            printNonFatalError(error);
            continue;
          }
          const latest = await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId));
          if (latest.latestVerification?.status === "failed") {
            failed = true;
          }
        }

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("review")
    .description("Run review agents for every repo task in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only review one repo")
    .action(async (id: string, options: { repo?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        let failed = false;

        for (const [index, repo] of repos.entries()) {
          if (index > 0) {
            console.log("");
          }
          console.log(`${repo.name}/${repo.taskId}`);
          const repoPaths = resolvePaths(repo.path);
          try {
            await reviewTask(repoPaths, repo.taskId, { exitOnFindings: false });
          } catch (error) {
            failed = true;
            printNonFatalError(error);
            continue;
          }
          const latest = await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId));
          if (latest.latestReviewAgent?.status !== "passed") {
            failed = true;
          }
        }

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("mark")
    .description("Manually mark stopped repo tasks in a group as review, approved, done, blocked, or cancelled.")
    .argument("<id>")
    .argument("<status>")
    .option("--repo <repo-name>", "Only mark one repo")
    .action((id: string, statusValue: string, options: { repo?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        const status = parseManualStatus(statusValue);
        let failed = false;

        for (const repo of repos) {
          const repoPaths = resolvePaths(repo.path);
          try {
            markTask(repoPaths, repo.taskId, status);
            console.log(`${repo.name}/${repo.taskId}: marked ${status}`);
          } catch (error) {
            failed = true;
            console.log(`${repo.name}/${repo.taskId}`);
            printNonFatalError(error);
          }
        }

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("approve")
    .description("Approve stopped repo tasks in a group after policy checks.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only approve one repo")
    .option("--force", "Approve even when checks or review are missing or failing")
    .action(async (id: string, options: { repo?: string; force?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        let failed = false;
        const rows: string[][] = [];

        for (const repo of repos) {
          const repoPaths = resolvePaths(repo.path);
          try {
            const result = await approveTask(repoPaths, repo.taskId, { force: options.force === true });
            rows.push([repo.name, repo.taskId, "approved", result]);
          } catch (error) {
            failed = true;
            rows.push([repo.name, repo.taskId, "failed", error instanceof Error ? error.message.split("\n")[0] : String(error)]);
          }
        }

        printTable(["REPO", "TASK", "STATUS", "DETAIL"], rows);

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("commit")
    .description("Commit current worktree changes for repo tasks in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only commit one repo")
    .option("-m, --message <message>", "Commit message")
    .action(async (id: string, options: { repo?: string; message?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        let failed = false;

        for (const [index, repo] of repos.entries()) {
          if (index > 0) {
            console.log("");
          }
          console.log(`${repo.name}/${repo.taskId}`);
          const repoPaths = resolvePaths(repo.path);
          try {
            await commitTask(repoPaths, repo.taskId, { message: options.message });
          } catch (error) {
            failed = true;
            printNonFatalError(error);
          }
        }

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("pr")
    .description("Push existing branch commits and open PRs for repo tasks in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only open a PR for one repo")
    .option("--title <title>", "PR title")
    .option("--body <body>", "PR body")
    .option("--draft", "Create draft PRs")
    .option("--ready", "Create ready-for-review PRs instead of drafts")
    .action(async (id: string, options: PrOptions & { repo?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        const draft = resolvePrDraftMode(options);
        const preflights = await Promise.all(
          repos.map(async (repo) => {
            const repoPaths = resolvePaths(repo.path);
            const meta = getTask(repoPaths, repo.taskId);
            return {
              repo,
              meta,
              preflight: await preflightScmForPullRequest(meta.worktreePath, { draft })
            };
          })
        );
        printGroupPrPreflight(preflights, draft ? "draft" : "ready");
        if (preflights.some(({ meta, preflight }) => !isPrPreflightReady(meta, preflight, draft))) {
          process.exit(1);
        }

        let failed = false;
        const results: Array<{ repo: string; task: string; status: string; pr: string }> = [];

        for (const repo of repos) {
          const repoPaths = resolvePaths(repo.path);
          const meta = getTask(repoPaths, repo.taskId);
          if (meta.status === "pr-open" && meta.prUrl) {
            results.push({ repo: repo.name, task: repo.taskId, status: "already-open", pr: meta.prUrl });
            continue;
          }
          try {
            const prUrl = await openPrForTask(repoPaths, repo.taskId, options);
            results.push({ repo: repo.name, task: repo.taskId, status: "opened", pr: prUrl });
          } catch (error) {
            failed = true;
            results.push({
              repo: repo.name,
              task: repo.taskId,
              status: "failed",
              pr: error instanceof Error ? error.message.split("\n")[0] : String(error)
            });
            printNonFatalError(error);
          }
        }

        console.log("");
        printTable(
          ["REPO", "TASK", "STATUS", "PR"],
          results.map((result) => [result.repo, result.task, result.status, result.pr])
        );

        if (failed) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("board")
    .description("Show all repo tasks in a group with next commands.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const rows = await buildGroupBoardRows(paths, id);
        if (rows.length === 0) {
          console.log("No repos in group");
          return;
        }

        printTable(
          ["REPO", "TASK", "STATUS", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [row.repo, row.task, row.status, row.check, row.review, row.pr, row.updated, row.next])
        );
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("doctor")
    .description("Inspect SCM/auth readiness for repo tasks in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only inspect one repo")
    .action(async (id: string, options: { repo?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        const rows = await Promise.all(
          repos.map(async (repo) => {
            const repoPaths = resolvePaths(repo.path);
            const meta = getTask(repoPaths, repo.taskId);
            const preflight = await preflightScmForPullRequest(meta.worktreePath, { draft: false });
            return { repo, preflight };
          })
        );
        printTable(
          ["REPO", "TASK", "PROVIDER", "AUTH", "CLEAN", "COMMITS"],
          rows.map(({ repo, preflight }) => [
            repo.name,
            repo.taskId,
            preflight.provider,
            preflight.auth,
            preflight.clean ? "ok" : "dirty",
            preflight.commits > 0 ? "yes" : "no"
          ])
        );
        const details = rows.filter(({ preflight }) => preflight.authDetail);
        if (details.length > 0) {
          console.log("");
          console.log("Details:");
          for (const { repo, preflight } of details) {
            console.log(`${repo.name}/${repo.taskId}: ${preflight.authDetail}`);
          }
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("next")
    .description("Recommend next workflow actions across a group.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        if (groupData.repos.length === 0) {
          console.log("No repos in group");
          return;
        }

        for (const repo of groupData.repos) {
          const repoPaths = resolvePaths(repo.path);
          const config = readConfig(repoPaths);
          const review = await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId));
          const next = withRepoCommand(recommendNextAction(review, config), repo.name, repo.path);
          printNextAction(`${repo.name}/${repo.taskId}`, next);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("run")
    .description("Run created or paused repo tasks in a group.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        for (const repo of groupData.repos) {
          const repoPaths = resolvePaths(repo.path);
          const meta = getTask(repoPaths, repo.taskId);
          if (!["created", "paused"].includes(meta.status)) {
            console.log(`${repo.name}/${repo.taskId}: skipped (${meta.status})`);
            continue;
          }
          printStartedWorker(`${repo.name}/${repo.taskId}`, startWorker(repoPaths, repo.taskId), "Running");
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("advance")
    .description("Run safe next workflow steps across a group.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        for (const repo of groupData.repos) {
          const repoPaths = resolvePaths(repo.path);
          const config = readConfig(repoPaths);
          const review = await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId));
          const next = recommendNextAction(review, config);
          console.log("");
          console.log(`${repo.name}/${repo.taskId}`);
          console.log(`  Status: ${review.meta.status}`);

          if (!next.automatic) {
            const recommended = withRepoCommand(next, repo.name, repo.path);
            console.log(`  Action: skipped`);
            console.log(`  Reason: ${recommended.reason}`);
            console.log(`  Next: ${recommended.command ?? "-"}`);
            continue;
          }

          console.log(`  Action: ${next.kind}`);
          await advanceTask(repoPaths, repo.taskId, next);
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
        const status = parseManualStatus(statusValue);
        markTask(paths, id, status);
        console.log(`Marked task ${id} as ${status}`);
      } catch (error) {
        printError(error);
      }
    });

  program
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
        await reviewAction(id);
      } catch (error) {
        printError(error);
      }
    });

  program
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

  program
    .command("pr")
    .description("Push existing task branch commits and open a GitHub PR.")
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

  program
    .command("ci")
    .description("Check GitHub PR CI status for a task.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        await ciAction(id);
      } catch (error) {
        printError(error);
      }
    });

  program
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

  program
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
          case "run": {
            printStartedWorker(id, startWorker(paths, id), "Running");
            return;
          }
          case "continue": {
            const meta = getTask(paths, id);
            printStartedWorker(id, startWorker(paths, id, { tmux: meta.tmuxSession !== null }), "Continuing");
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

  program
    .command("run")
    .description("Run or continue a task worker in the background.")
    .argument("<id>")
    .option("--tmux", "Run the worker inside a tmux session")
    .action((id: string, options: { tmux?: boolean }) => {
      try {
        const paths = resolvePaths();
        const started = startWorker(paths, id, { tmux: options.tmux === true });
        printStartedWorker(id, started, "Running");
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

        const started = startWorker(paths, id, { tmux: meta.tmuxSession !== null });
        printStartedWorker(id, started, "Continuing");
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

function printStartedWorker(id: string, started: StartedWorker, verb: "Running" | "Continuing"): void {
  console.log(`${verb} task ${id}`);
  if (started.tmuxSession) {
    console.log(`tmux: ${started.tmuxSession}`);
    return;
  }
  console.log(`Supervisor PID: ${started.pid ?? "-"}`);
}

function printNextAction(id: string, next: NextAction): void {
  console.log(id);
  console.log(`  ${next.reason}`);
  if (next.command) {
    console.log(`  Next: ${next.command}`);
  } else {
    console.log("  Next: -");
  }
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => displayWidth(row[index] ?? "")))
  );

  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index])).join("  "));
  }
}

function displayWidth(value: string): number {
  return value.length;
}

function listTemplateScripts(): string[] {
  const dir = templateScriptsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sh"))
    .map((file) => file.replace(/\.sh$/, ""))
    .sort();
}

function installTemplateScripts(paths: ReturnType<typeof resolvePaths>, options: { force: boolean }): string[] {
  const targetDir = scriptsDir(paths);
  fs.mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];

  for (const name of listTemplateScripts()) {
    const source = templateScriptPath(name);
    const target = installedScriptPath(paths, name);
    if (fs.existsSync(target) && !options.force) {
      continue;
    }

    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    installed.push(target);
  }

  return installed;
}

function templateScriptPath(name: string): string {
  assertKnownScriptName(name);
  const filePath = path.join(templateScriptsDir(), `${name}.sh`);
  if (!fs.existsSync(filePath)) {
    throw new DevtaskError(`Unknown script ${name}`);
  }

  return filePath;
}

function installedScriptPath(paths: ReturnType<typeof resolvePaths>, name: string): string {
  assertKnownScriptName(name);
  return path.join(scriptsDir(paths), `${name}.sh`);
}

function templateScriptsDir(): string {
  return fileURLToPath(new URL("./templates/scripts", import.meta.url));
}

function assertKnownScriptName(name: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new DevtaskError("Script name may only contain letters, numbers, dots, underscores, and dashes");
  }
}

interface GroupCreateRepoSpec {
  name: string;
  repoPath: string;
  taskId: string;
}

interface PlannedGroupCreateRepo {
  name: string;
  paths: ReturnType<typeof resolvePaths>;
  taskId: string;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readGroupGoal(
  paths: ReturnType<typeof resolvePaths>,
  options: { goal?: string; goalFile?: string }
): string | undefined {
  if (options.goal && options.goalFile) {
    throw new DevtaskError("Use either --goal or --goal-file, not both");
  }
  if (!options.goalFile) {
    return options.goal;
  }

  const filePath = path.resolve(paths.root, options.goalFile);
  if (!fs.existsSync(filePath)) {
    throw new DevtaskError(`Goal file does not exist: ${filePath}`);
  }
  const goal = fs.readFileSync(filePath, "utf8").trim();
  if (!goal) {
    throw new DevtaskError(`Goal file is empty: ${filePath}`);
  }
  return goal;
}

function parseGroupCreateRepoSpecs(values: string[]): GroupCreateRepoSpec[] {
  return values.map((value) => {
    const equalsIndex = value.indexOf("=");
    const colonIndex = value.lastIndexOf(":");
    if (equalsIndex <= 0 || colonIndex <= equalsIndex + 1 || colonIndex === value.length - 1) {
      throw new DevtaskError(`Invalid --repo spec ${value}. Expected name=path:task-id`);
    }

    return {
      name: value.slice(0, equalsIndex),
      repoPath: value.slice(equalsIndex + 1, colonIndex),
      taskId: value.slice(colonIndex + 1)
    };
  });
}

function preflightGroupCreateRepos(
  paths: ReturnType<typeof resolvePaths>,
  groupId: string,
  specs: GroupCreateRepoSpec[]
): PlannedGroupCreateRepo[] {
  const names = new Set<string>();
  const repoPaths = new Set<string>();
  const taskIds = new Set<string>();
  const planned = specs.map((spec) => {
    assertValidGroupRepoName(spec.name);
    assertValidTaskId(spec.taskId);

    if (names.has(spec.name)) {
      throw new DevtaskError(`Duplicate repo name in group ${groupId}: ${spec.name}`);
    }
    names.add(spec.name);

    const repoPathsForSpec = resolveRepoPathForGroup(spec.repoPath);
    if (repoPaths.has(repoPathsForSpec.root)) {
      throw new DevtaskError(`Duplicate repo path in group ${groupId}: ${repoPathsForSpec.root}`);
    }
    repoPaths.add(repoPathsForSpec.root);

    if (taskIds.has(spec.taskId)) {
      throw new DevtaskError(`Duplicate task id in group ${groupId}: ${spec.taskId}`);
    }
    taskIds.add(spec.taskId);

    if (fs.existsSync(taskMetaPath(repoPathsForSpec, spec.taskId))) {
      throw new DevtaskError(`Task ${spec.taskId} already exists in repo ${repoPathsForSpec.root}`);
    }

    return {
      name: spec.name,
      paths: repoPathsForSpec,
      taskId: spec.taskId
    };
  });

  if (planned.length > 0 && fs.existsSync(path.join(paths.groupsDir, groupId, "group.json"))) {
    throw new DevtaskError(`Group ${groupId} already exists`);
  }

  return planned;
}

function assertValidGroupRepoName(name: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new DevtaskError("Repo name may only contain letters, numbers, dots, underscores, and dashes");
  }
}

function buildGroupRepoGoal(groupId: string, groupGoal: string | undefined, repoName: string): string {
  const goal = groupGoal?.trim() ? groupGoal.trim() : `Complete the repo-local part of group ${groupId}.`;
  return `${goal}\n\nRepository: ${repoName}\nWork only on this repository's scoped part of the group task.`;
}

function resolveRepoPathForGroup(repoPath: string): ReturnType<typeof resolvePaths> {
  try {
    return resolvePaths(repoPath);
  } catch (error) {
    const resolved = fs.existsSync(repoPath) ? fs.realpathSync(repoPath) : repoPath;
    if (!fs.existsSync(repoPath)) {
      throw new DevtaskError(`Repo path does not exist: ${resolved}`);
    }
    if (error instanceof DevtaskError) {
      throw new DevtaskError(`Repo path is not inside a git repository: ${resolved}`);
    }
    throw error;
  }
}

function printGroupLog(
  repoName: string,
  repoPath: string,
  taskId: string,
  options: { lines: number; follow: boolean }
): void {
  const repoPaths = resolvePaths(repoPath);
  getTask(repoPaths, taskId);
  const logPath = readLatestLogPath(repoPaths, taskId);
  if (!logPath) {
    console.log(`${repoName}/${taskId}: no logs`);
    return;
  }

  console.log(`${repoName}/${taskId}`);
  console.log(`Log: ${logPath}`);
  if (options.follow) {
    followFile(logPath, options.lines);
    return;
  }

  console.log(tailFile(logPath, options.lines));
}

function markTask(paths: ReturnType<typeof resolvePaths>, id: string, status: ReturnType<typeof parseManualStatus>): void {
  const meta = getTask(paths, id);
  assertCanMark(meta, status);

  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    status,
    supervisorPid: null,
    childPid: null,
    tmuxSession: status === "cancelled" ? null : meta.tmuxSession,
    updatedAt: new Date().toISOString()
  });
}

async function approveTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { force: boolean }
): Promise<string> {
  const meta = getTask(paths, id);
  assertCanMark(meta, "approved");
  const issues = await collectApprovalIssues(paths, meta);
  if (issues.length > 0 && !options.force) {
    throw new DevtaskError(
      `Task ${id} is not ready for approval:\n${issues.map((issue) => `  - ${issue}`).join("\n")}\nUse --force to approve anyway.`
    );
  }

  markTask(paths, id, "approved");
  return issues.length > 0 ? `forced: ${issues.join("; ")}` : "policy passed";
}

async function collectApprovalIssues(paths: ReturnType<typeof resolvePaths>, meta: ReturnType<typeof getTask>): Promise<string[]> {
  const issues: string[] = [];
  const config = readConfig(paths);
  const review = await buildTaskReview(paths, meta);

  if (config.verify.length > 0) {
    if (!review.latestVerification) {
      issues.push("checks missing");
    } else if (review.latestVerification.status !== "passed") {
      issues.push(`checks ${review.latestVerification.status}`);
    } else if (!isArtifactFresh(review.latestVerification.finishedAt, meta.updatedAt)) {
      issues.push("checks stale");
    }
  }

  if (!review.latestReviewAgent) {
    issues.push("review missing");
  } else if (review.latestReviewAgent.status !== "passed") {
    issues.push(`review ${review.latestReviewAgent.status}`);
  } else {
    const baseline = review.latestVerification?.finishedAt ?? meta.updatedAt;
    if (!isArtifactFresh(review.latestReviewAgent.finishedAt, baseline)) {
      issues.push("review stale");
    }
  }

  return issues;
}

function isArtifactFresh(finishedAt: string | undefined, baseline: string): boolean {
  if (!finishedAt) {
    return false;
  }
  return Date.parse(finishedAt) >= Date.parse(baseline);
}

function selectGroupRepos(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  repoName?: string
): ReturnType<typeof getGroup>["repos"] {
  const group = getGroup(paths, id);
  const repos = repoName ? group.repos.filter((repo) => repo.name === repoName) : group.repos;
  if (repos.length === 0) {
    throw new DevtaskError(repoName ? `Group ${id} does not have repo ${repoName}` : "No repos in group");
  }
  return repos;
}

function normalizeCleanupOptions(
  options: CleanupOptions & { keepWorktrees?: boolean; keepMetadata?: boolean }
): CleanupOptions {
  return {
    dryRun: options.dryRun === true,
    force: options.force === true,
    keepWorktree: options.keepWorktree === true || options.keepWorktrees === true,
    keepMetadata: options.keepMetadata === true
  };
}

function printCleanupPlan(label: string, plan: CleanupPlan): void {
  console.log(label);
  for (const action of plan.actions) {
    console.log(`  PLAN ${action}`);
  }
  for (const blocker of plan.blockers) {
    console.log(`  BLOCKED ${blocker}`);
  }
}

interface GroupBoardRow {
  repo: string;
  task: string;
  status: string;
  check: string;
  review: string;
  pr: string;
  updated: string;
  next: string;
}

function printGroupPrPreflight(
  rows: Array<{ repo: ReturnType<typeof getGroup>["repos"][number]; meta: ReturnType<typeof getTask>; preflight: ScmPreflight }>,
  mode: string
): void {
  console.log("Preflight:");
  printTable(
    ["REPO", "TASK", "STATUS", "PROVIDER", "AUTH", "CLEAN", "COMMITS", "MODE", "PR"],
    rows.map(({ repo, meta, preflight }) => [
      repo.name,
      repo.taskId,
      meta.status,
      preflight.provider,
      preflight.auth,
      preflight.clean ? "ok" : "dirty",
      preflight.commits > 0 ? "yes" : "no",
      mode === "draft" && !preflight.draftSupported ? "unsupported" : mode,
      meta.prUrl ? "open" : "-"
    ])
  );
  const details = rows.filter(({ preflight }) => preflight.authDetail);
  if (details.length > 0) {
    console.log("");
    console.log("Preflight details:");
    for (const { repo, preflight } of details) {
      console.log(`${repo.name}/${repo.taskId}: ${preflight.authDetail}`);
    }
  }
  console.log("");
}

function isPrPreflightReady(meta: ReturnType<typeof getTask>, preflight: ScmPreflight, draft: boolean): boolean {
  if (meta.status === "pr-open" && meta.prUrl) {
    return true;
  }
  return preflight.auth === "ok" && preflight.clean && preflight.commits > 0 && (!draft || preflight.draftSupported);
}

async function buildGroupBoardRows(paths: ReturnType<typeof resolvePaths>, id: string): Promise<GroupBoardRow[]> {
  const group = getGroup(paths, id);
  const rows: GroupBoardRow[] = [];

  for (const repo of group.repos) {
    const repoPaths = resolvePaths(repo.path);
    const config = readConfig(repoPaths);
    const row = buildBoardRow(await buildTaskReview(repoPaths, getTask(repoPaths, repo.taskId)), config);
    rows.push({
      repo: repo.name,
      task: row.id,
      status: row.status,
      check: row.check,
      review: row.review,
      pr: row.pr,
      updated: row.updated,
      next: rewriteCommandForRepo(row.next, repo.path)
    });
  }

  return rows;
}

function withRepoCommand(next: NextAction, repoName: string, repoPath: string): NextAction {
  return {
    ...next,
    command: next.command ? rewriteCommandForRepo(next.command, repoPath) : null,
    reason: `${repoName}: ${next.reason}`
  };
}

function rewriteCommandForRepo(command: string, repoPath: string): string {
  if (!command.startsWith("devtask ")) {
    return command;
  }

  return `(cd ${shellQuote(repoPath)} && ${command})`;
}

async function advanceTask(paths: ReturnType<typeof resolvePaths>, id: string, next: NextAction): Promise<void> {
  switch (next.kind) {
    case "run":
      printStartedWorker(id, startWorker(paths, id), "Running");
      return;
    case "continue": {
      const meta = getTask(paths, id);
      printStartedWorker(id, startWorker(paths, id, { tmux: meta.tmuxSession !== null }), "Continuing");
      return;
    }
    case "check":
      await checkTask(paths, id, { exitOnFailure: false });
      return;
    case "review":
      await reviewTask(paths, id, { exitOnFindings: false });
      return;
    case "pr":
      await openPrForTask(paths, id, {});
      return;
    case "ci":
      await checkCiForTask(paths, id);
      return;
    default:
      printNextAction(id, next);
  }
}

async function checkTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { exitOnFailure: boolean }
): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before checking`);
  }

  const config = readConfig(paths);
  if (config.verify.length === 0) {
    throw new DevtaskError("No check commands configured. Use devtask config check <command...>");
  }

  console.log(`Running ${config.verify.length} check command${config.verify.length === 1 ? "" : "s"} in ${meta.worktreePath}`);
  const record = await runVerification(paths, meta, config.verify, {
    onStepStart: (command, index, total) => {
      console.log(`[${index}/${total}] ${command}`);
    }
  });
  console.log(`Check: ${record.status}`);
  for (const step of record.steps) {
    console.log(`${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
    if (step.exitCode !== 0) {
      if (step.stdout.trim()) console.log(step.stdout.trim());
      if (step.stderr.trim()) console.error(step.stderr.trim());
      if (options.exitOnFailure) {
        process.exit(1);
      }
    }
  }
}

async function reviewTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { exitOnFindings: boolean }
): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before review`);
  }

  const config = readConfig(paths);
  console.log(`Running review agent in ${meta.worktreePath}`);
  const record = await runReviewAgent(paths, meta, {
    model: meta.model ?? config.codex.model,
    fullAuto: config.codex.fullAuto,
    onStart: (start) => {
      console.log(`Prompt: ${start.promptPath}`);
      console.log(`Output: ${start.outputPath}`);
      console.log(`Command: ${start.command}`);
    },
    onStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    onStderr: (chunk) => {
      process.stderr.write(chunk);
    }
  });
  console.log(`Review agent: ${record.status}`);
  console.log(`Output: ${record.outputPath}`);
  if (record.status !== "passed" && options.exitOnFindings) {
    process.exit(record.exitCode === 0 ? 2 : 1);
  }
}

async function openPrForTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: PrOptions
): Promise<string> {
  const draft = resolvePrDraftMode(options);
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before opening a PR`);
  }
  if (!["approved", "ci-failed"].includes(meta.status)) {
    throw new DevtaskError(`Task ${id} is ${meta.status}; mark it approved before opening a PR`);
  }

  const uncommitted = await hasUncommittedChanges(meta.worktreePath);
  if (uncommitted) {
    throw new DevtaskError(
      `Task ${id} has uncommitted changes. Run devtask commit ${id}, or ask the agent to continue and commit its work.`
    );
  }
  const commitCount = await countBranchCommits(meta.worktreePath);
  if (commitCount === 0) {
    throw new DevtaskError(`Task ${id} has no branch commits to publish. Run devtask commit ${id} first.`);
  }

  const prUrl = await createPullRequest(meta, {
    title: options.title ?? meta.id,
    body: options.body ?? defaultPrBody(meta),
    draft
  });

  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    status: "pr-open",
    prUrl,
    updatedAt: new Date().toISOString()
  });
  console.log(prUrl);
  return prUrl;
}

async function commitTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { message?: string } = {}
): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before committing`);
  }

  await runCommandOrThrow("git", ["add", "-A"], { cwd: meta.worktreePath });
  const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: meta.worktreePath });
  if (staged.exitCode === 0) {
    console.log(`No changes to commit for ${id}`);
    return;
  }

  const message = options.message ?? meta.id;
  await runCommandOrThrow("git", ["commit", "-m", message], { cwd: meta.worktreePath });
  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    updatedAt: new Date().toISOString()
  });
  console.log(`Committed ${id}`);
}

async function checkCiForTask(paths: ReturnType<typeof resolvePaths>, id: string): Promise<void> {
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
}

function startWorker(paths: ReturnType<typeof resolvePaths>, id: string, options: { tmux?: boolean } = {}): StartedWorker {
  const meta = getTask(paths, id);
  if (isProcessAlive(meta.supervisorPid)) {
    throw new DevtaskError(`Task ${id} is already supervised by PID ${meta.supervisorPid}`);
  }
  if (meta.status === "done") {
    throw new DevtaskError(`Task ${id} is ${meta.status} and cannot be run`);
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
  return createProviderPullRequest(meta.worktreePath, {
    ...options,
    branch: meta.branch
  });
}

function resolvePrDraftMode(options: PrOptions): boolean {
  if (options.ready && options.draft) {
    throw new DevtaskError("Use either --ready or --draft, not both");
  }
  return options.ready !== true;
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
