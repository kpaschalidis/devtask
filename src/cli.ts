import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import { planMarkdownPath, resolvePaths, resolveWorkspacePaths, resolveWorkspacePathsForInit, scriptsDir, taskMetaPath } from "./paths.js";
import { writeTaskMeta } from "./meta.js";
import { isProcessAlive, terminateProcessGroup } from "./processes.js";
import { createTask, getTask, initializeStore, initializeWorkspace, listTasks } from "./task-store.js";
import { buildTaskReview, inspectTaskHealth, readLatestLogPath, readLatestRun } from "./task-inspection.js";
import {
  attachTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  sendToTmuxSessionWithConfirmation,
  startTmuxSession,
  tmuxSessionExists,
  tmuxSessionName
} from "./tmux.js";
import { buildCodexCommand, hasRuntimeConfig, readConfig, writeConfig } from "./config.js";
import { assertCanMark, parseManualStatus } from "./lifecycle.js";
import { readLatestVerification, runVerification, type VerificationRecord } from "./verification.js";
import { runCommand, runCommandOrThrow } from "./process-runner.js";
import { readLatestReviewAgent, runReviewAgent, type ReviewAgentRecord } from "./review-agent.js";
import { hasTaskPlan, runPlanAgent } from "./planner.js";
import { buildBoardRow, recommendNextAction, type NextAction } from "./workflow.js";
import { addRepoToGroup, createGroup, deleteGroup, getGroup, groupDir, listGroups, removeRepoFromGroup } from "./group-store.js";
import { readGroupOrchestration, runGroupOrchestrator } from "./group-orchestrator.js";
import { cleanupTask, planTaskCleanup, type CleanupOptions, type CleanupPlan } from "./cleanup.js";
import { assertValidTaskId } from "./task-id.js";
import {
  checkProviderCi,
  countBranchCommits,
  createProviderPullRequest,
  detectRemoteInfo,
  hasUncommittedChanges,
  preflightScmForPullRequest,
  type ScmPreflight
} from "./scm.js";
import { recordStage, runStage, STAGE_NAMES } from "./stage-contracts.js";
import { assertCheckReady, assertCiReady, assertCommitReady, assertPrReady, assertReviewReady, assertRunReady } from "./stage-policy.js";
import {
  assertJiraConfigured,
  buildJiraGroupRepoGoal,
  buildJiraTaskGoal,
  checkJiraAuth,
  fetchJiraIssue,
  renderJiraIssueMarkdown,
  writeJiraSourceArtifacts,
  type JiraIssue
} from "./jira.js";
import {
  addWorkspaceTarget,
  getWorkspaceTarget,
  listWorkspaceTargets,
  removeWorkspaceTarget,
  type WorkspaceTarget
} from "./workspace-targets.js";
import { createJiraWorkItem, createManualWorkItem, getWorkItem, listWorkItems, type WorkItem } from "./work-store.js";
import { runWorkPlanner, workGraphPath, workPlanPath } from "./work-planner.js";
import { approveWorkPlan, readWorkMaterialization } from "./work-materializer.js";
import { buildWorkBoardRows, type WorkBoardRow } from "./work-board.js";
import { isWorkTaskRunComplete, planWorkRun } from "./work-runner.js";
import {
  DEFAULT_DEV_WORKFLOW,
  runWorkflowStage,
  workflowStageFailed,
  type WorkflowStageId,
  type WorkflowUnit
} from "./workflow-engine.js";
import { createFixRequestFromCheck } from "./fix-request.js";

interface PrOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  ready?: boolean;
  target?: string;
}

type LogStage = "current" | "latest" | "run" | "check" | "review";

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
        const shouldConfigureRuntime = !hasRuntimeConfig(paths);
        initializeStore(paths);
        console.log(`Initialized ${paths.baseDir}`);
        if (shouldConfigureRuntime) {
          configureRuntimeFromEnvironment(paths);
        } else {
          console.log(`Runtime: ${formatRuntime(readConfig(paths))}`);
        }
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
    .command("runtime")
    .description("Show or update the task runtime mode.")
    .argument("[mode]", "attachable or plain")
    .action((mode?: string) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const current = readConfig(paths);

        if (!mode) {
          console.log(formatRuntime(current));
          return;
        }

        const runtime = parseRuntimeMode(mode);
        writeConfig(paths, {
          ...current,
          runtime,
          runtimeConfigured: true
        });
        console.log(`Runtime: ${formatRuntime({ ...current, runtime, runtimeConfigured: true })}`);
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

  config
    .command("jira")
    .description("Show or update Jira source configuration.")
    .option("--base-url <url>", "Jira Cloud base URL, for example https://company.atlassian.net")
    .option("--email <email>", "Jira account email used with JIRA_API_TOKEN")
    .option("--cloud-id <id>", "Jira Cloud ID for scoped Atlassian API tokens")
    .action((options: { baseUrl?: string; email?: string; cloudId?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeStore(paths);
        const current = readConfig(paths);

        if (!options.baseUrl && !options.email && !options.cloudId) {
          console.log(JSON.stringify(current.jira, null, 2));
          return;
        }

        const jira = {
          baseUrl: options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : current.jira.baseUrl,
          email: options.email ?? current.jira.email,
          cloudId: options.cloudId ?? current.jira.cloudId
        };
        writeConfig(paths, {
          ...current,
          jira
        });
        console.log("Jira config:");
        console.log(JSON.stringify(jira, null, 2));
      } catch (error) {
        printError(error);
      }
    });

  const workspace = program.command("workspace").description("Manage workspace-level devtask configuration.");
  const workspaceTarget = workspace.command("target").description("Manage workspace targets used by work-item orchestration.");

  workspaceTarget
    .command("list")
    .alias("ls")
    .description("List workspace targets.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        const targets = listWorkspaceTargets(paths);
        if (targets.length === 0) {
          console.log("No workspace targets");
          return;
        }
        printWorkspaceTargets(targets);
      } catch (error) {
        printError(error);
      }
    });

  workspaceTarget
    .command("show")
    .description("Show one workspace target.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        console.log(JSON.stringify(getWorkspaceTarget(paths, id), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  workspaceTarget
    .command("add")
    .description("Add a repo or repo scope as an orchestration target.")
    .argument("<id>")
    .argument("<repo-path>")
    .option("--scope <path>", "Optional path inside the target repo")
    .option("--kind <kind>", "Optional target kind, for example api, frontend, docs")
    .action((id: string, repoPath: string, options: { scope?: string; kind?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const target = addWorkspaceTarget(paths, {
          id,
          repoPath,
          scope: options.scope,
          kind: options.kind
        });
        console.log(`Added target ${target.id}`);
        console.log(`Repo: ${target.repoPath}`);
        console.log(`Scope: ${target.scope ?? "."}`);
        console.log(`Kind: ${target.kind ?? "-"}`);
      } catch (error) {
        printError(error);
      }
    });

  workspaceTarget
    .command("remove")
    .alias("rm")
    .description("Remove a workspace target.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const removed = removeWorkspaceTarget(paths, id);
        console.log(`Removed target ${removed.id}`);
      } catch (error) {
        printError(error);
      }
    });

  const work = program.command("work").description("Manage durable work items before they become repo tasks.");

  work
    .command("create")
    .description("Create a work item from a manual title or Jira issue.")
    .argument("<id>")
    .option("--title <title>", "Manual work item title")
    .option("--body <body>", "Manual work item description")
    .option("--from-jira", "Fetch the id as a Jira issue and use it as the source")
    .action(async (id: string, options: { title?: string; body?: string; fromJira?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        let item: WorkItem;
        if (options.fromJira) {
          if (options.title || options.body) {
            throw new DevtaskError("Use either --from-jira or manual --title/--body, not both");
          }
          const issue = await fetchJiraIssue(readConfig(paths), id);
          const artifacts = writeJiraSourceArtifacts(paths, issue);
          item = createJiraWorkItem(paths, {
            id: issue.key,
            key: issue.key,
            title: issue.summary,
            url: issue.url,
            artifact: artifacts.markdownPath
          });
          console.log(`Fetched ${issue.key}: ${issue.summary}`);
          console.log(`Source: ${artifacts.markdownPath}`);
        } else {
          if (!options.title) {
            throw new DevtaskError("Manual work items require --title, or use --from-jira");
          }
          item = createManualWorkItem(paths, {
            id,
            title: options.title,
            body: options.body
          });
        }

        console.log(`Created work item ${item.id}`);
        console.log(`Status: ${item.status}`);
        console.log(`Source: ${item.source.artifact}`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("list")
    .alias("ls")
    .description("List work items.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        const items = listWorkItems(paths);
        if (items.length === 0) {
          console.log("No work items");
          return;
        }
        printWorkItems(items);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("show")
    .description("Show one work item.")
    .argument("<id>")
    .action((id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        console.log(JSON.stringify(getWorkItem(paths, id), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("board")
    .description("Show work-item planning/materialization state and repo task next commands.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const rows = await buildWorkBoardRows(paths, item);
        printTable(
          ["TARGET", "TASK", "STAGE", "STATUS", "LAST", "BLOCKED", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [
            row.target,
            row.task,
            row.stage,
            row.status,
            row.last,
            row.blocked,
            row.check,
            row.review,
            row.pr,
            row.updated,
            row.next
          ])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("logs")
    .description("Print or follow logs for materialized repo tasks in a work item.")
    .argument("<id>")
    .option("--target <target-id>", "Only show logs for one workspace target")
    .option("--stage <stage>", "Stage output to show: current, latest, run, check, or review", parseLogStage, "current")
    .option("-n, --lines <count>", "Number of trailing lines to print", parsePositiveInteger, 120)
    .option("-f, --follow", "Follow one target task log")
    .action(async (id: string, options: { target?: string; stage: LogStage; lines: number; follow?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const tasks = selectWorkLogTasks(paths, item, options.target);
        const boardRows = options.stage === "current" ? await buildWorkBoardRows(paths, item) : [];
        if (options.follow && tasks.length !== 1) {
          throw new DevtaskError("Use --target when following work logs");
        }

        for (const [index, task] of tasks.entries()) {
          if (index > 0) {
            console.log("");
          }
          printWorkLog(task.target, task.repoPath, task.taskId, {
            stage: resolveRequestedLogStage(options.stage, task.target, task.taskId, boardRows),
            lines: options.lines,
            follow: options.follow === true
          });
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("plan")
    .description("Create or refresh the proposed execution graph for a work item.")
    .argument("<id>")
    .option("--refresh", "Regenerate the latest work plan and proposed graph before materialization")
    .option("--attachable", "Run the work planning agent inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const materialization = readWorkMaterialization(paths, item.id);
        if (materialization && options.refresh) {
          throw new DevtaskError(
            `Work item ${item.id} has already been materialized. Use repo-local commands or cleanup before replanning.`
          );
        }
        if (materialization) {
          printMaterializedWorkPlan(paths, item.id, materialization.tasks.length);
          return;
        }
        if (!options.refresh && existingWorkPlanArtifacts(paths, item.id)) {
          printExistingWorkPlan(paths, item.id);
          return;
        }
        if (startStageSessionIfRequested(paths, item.id, "work-plan", ["work", "plan", id, "--plain", ...(options.refresh ? ["--refresh"] : [])], options)) {
          return;
        }
        const config = readConfig(paths);
        console.log(`Running work planner for ${item.id}`);
        const record = await runWorkPlanner(paths, item, config, {
          onStart: (start) => {
            console.log(`Prompt: ${start.promptPath}`);
            console.log(`Plan: ${start.planPath}`);
            console.log(`Graph: ${start.graphPath}`);
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
        console.log(`Plan: ${record.status}`);
        console.log(`File: ${record.planPath}`);
        console.log(`Graph: ${record.graphPath}`);
        if (record.status === "failed") {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("approve-plan")
    .description("Approve a work graph and materialize repo-local task worktrees.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const materialization = await approveWorkPlan(paths, item);
        console.log(`Approved work plan ${id}`);
        console.log(`Materialization: ${materialization.tasks.length} task(s)`);
        for (const task of materialization.tasks) {
          console.log(`${task.target}/${task.taskId}`);
          console.log(`  Repo: ${task.repoPath}`);
          console.log(`  Branch: ${task.branch}`);
          console.log(`  Worktree: ${task.worktreePath}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("repo-plan")
    .description("Run repo-specialist planning agents for materialized repo tasks.")
    .argument("<id>")
    .option("--refresh", "Regenerate repo-local task plans before tasks run")
    .option("--attachable", "Run repo planning agents inside attachable tmux sessions")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const results = await runWorkRepoPlans(paths, item, options);
        if (results.length === 0) {
          console.log(`No materialized tasks for work item ${id}`);
          return;
        }
        printTable(
          ["TARGET", "TASK", "STATUS", "PLAN"],
          results.map((result) => [result.target, result.taskId, result.status, result.planPath])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("run")
    .description("Run repo-local tasks that are ready in an approved work graph.")
    .argument("<id>")
    .option("--attachable", "Run workers inside attachable tmux sessions")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run workers as plain detached background processes")
    .option("--follow", "Keep running and start newly unblocked tasks until the run graph settles")
    .option("--poll <seconds>", "Polling interval for --follow", parsePositiveInteger, 5)
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean; follow?: boolean; poll: number }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        if (options.follow) {
          await followWorkRun(paths, item, options);
        } else {
          await runReadyWorkTasks(paths, item, options);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("check")
    .description("Run configured checks for materialized repo tasks.")
    .argument("<id>")
    .option("--target <target-id>", "Only run checks for one workspace target")
    .option("--verbose", "Stream repo-local check output while checks run")
    .action(async (id: string, options: { target?: string; verbose?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "check", options.target, async (unit) => {
          const repoPaths = resolvePaths(unit.repoPath);
          const config = readConfig(repoPaths);
          console.log(`${unit.target}/${unit.taskId}: running ${config.verify.length} check command${config.verify.length === 1 ? "" : "s"}`);
          const verification = await checkTask(repoPaths, unit.taskId, {
            exitOnFailure: false,
            verbose: options.verbose === true
          });
          console.log(`${unit.target}/${unit.taskId}: ${verification.status}`);
          return {
            status: verification.status === "failed" ? "failed" : "passed",
            detail: verification.status
          };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("review")
    .description("Run review agents for materialized repo tasks.")
    .argument("<id>")
    .option("--attachable", "Run review agents inside attachable tmux sessions")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .option("--target <target-id>", "Only run review for one workspace target")
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean; target?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "review", options.target, async (unit) => {
          const repoPaths = resolvePaths(unit.repoPath);
          assertReviewReady(repoPaths, getTask(repoPaths, unit.taskId), readConfig(repoPaths));
          if (startStageSessionIfRequested(repoPaths, unit.taskId, "review", ["review", unit.taskId, "--plain"], options)) {
            return { status: "started", detail: "stage session started" };
          }
          await reviewTask(repoPaths, unit.taskId, { exitOnFindings: false });
          const latest = await buildTaskReview(repoPaths, getTask(repoPaths, unit.taskId));
          return {
            status: latest.latestReviewAgent?.status === "passed" ? "passed" : "failed",
            detail: latest.latestReviewAgent?.status ?? "missing"
          };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("fix")
    .description("Run fix agents for materialized repo tasks from explicit failed-stage artifacts.")
    .argument("<id>")
    .option("--target <target-id>", "Only fix one workspace target")
    .option("--from <stage>", "Failed stage to fix", "check")
    .option("--attachable", "Run fix workers inside attachable tmux sessions")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run fix workers as plain detached background processes")
    .action(async (id: string, options: { target?: string; from: string; attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "fix", options.target, async (unit) => {
          const repoPaths = resolvePaths(unit.repoPath);
          const request = createFixRequest(repoPaths, unit.taskId, options.from);
          const runtime = resolveRunRuntime(repoPaths, options);
          printStartedWorker(`${unit.target}/${unit.taskId}`, startWorker(repoPaths, unit.taskId, { ...runtime, fix: true }), "Fixing");
          return { status: "started", detail: `${request.source}:${request.fixId}` };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("approve")
    .description("Approve materialized repo tasks after policy checks.")
    .argument("<id>")
    .option("--force", "Approve even when checks or review are missing or failing")
    .option("--target <target-id>", "Only approve one workspace target")
    .action(async (id: string, options: { force?: boolean; target?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "approve", options.target, async (unit) => {
          const detail = await approveTask(resolvePaths(unit.repoPath), unit.taskId, { force: options.force === true });
          return { status: "passed", detail };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("commit")
    .description("Commit current worktree changes for materialized repo tasks.")
    .argument("<id>")
    .option("-m, --message <message>", "Commit message")
    .option("--target <target-id>", "Only commit one workspace target")
    .action(async (id: string, options: { message?: string; target?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "commit", options.target, async (unit) => {
          await commitTask(resolvePaths(unit.repoPath), unit.taskId, { message: options.message });
          return { status: "passed", detail: "committed or skipped" };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("pr")
    .description("Push existing branch commits and open PRs for materialized repo tasks.")
    .argument("<id>")
    .option("--title <title>", "PR title")
    .option("--body <body>", "PR body")
    .option("--draft", "Create draft PRs")
    .option("--ready", "Create ready-for-review PRs instead of drafts")
    .option("--target <target-id>", "Only open a PR for one workspace target")
    .action(async (id: string, options: PrOptions) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const tasks = selectWorkTasks(paths, item, options.target);
        const draft = resolvePrDraftMode(options);
        const preflights = await Promise.all(
          tasks.map(async (task) => {
            const repoPaths = resolvePaths(task.repoPath);
            const meta = getTask(repoPaths, task.taskId);
            return {
              task,
              meta,
              preflight: await preflightScmForPullRequest(meta.worktreePath, { draft })
            };
          })
        );
        printWorkPrPreflight(preflights, draft ? "draft" : "ready");
        if (preflights.some(({ meta, preflight }) => !isWorkPrPreflightReady(meta, preflight, draft))) {
          process.exit(1);
        }

        const result = await runWorkWorkflowStage(paths, item, "pr", options.target, async (unit) => {
          const repoPaths = resolvePaths(unit.repoPath);
          const meta = getTask(repoPaths, unit.taskId);
          if (meta.status === "pr-open" && meta.prUrl) {
            return { status: "skipped", detail: meta.prUrl };
          }
          const prUrl = await openPrForTask(repoPaths, unit.taskId, options);
          return { status: "passed", detail: prUrl };
        });

        console.log("");
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "PR"], result);

        if (workflowStageFailed(result)) {
          process.exit(1);
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("ci")
    .description("Check CI status for materialized repo task PRs.")
    .argument("<id>")
    .option("--target <target-id>", "Only check CI for one workspace target")
    .action(async (id: string, options: { target?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await runWorkWorkflowStage(paths, item, "ci", options.target, async (unit) => {
          const repoPaths = resolvePaths(unit.repoPath);
          await checkCiForTask(repoPaths, unit.taskId);
          const meta = getTask(repoPaths, unit.taskId);
          return {
            status: meta.status === "ci-failed" ? "failed" : "passed",
            detail: meta.status
          };
        });
        printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
        if (workflowStageFailed(result)) {
          process.exit(1);
        }
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
        initializeStore(paths);
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
    .command("plan")
    .description("Run a planning-only agent and store the plan artifact.")
    .argument("<id>")
    .option("--attachable", "Run the planning agent inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        if (startStageSessionIfRequested(paths, id, "plan", ["plan", id, "--plain"], options)) {
          return;
        }
        await planTask(paths, id);
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
        const config = readConfig(paths);
        const issues = listTasks(paths).flatMap((summary) => inspectTaskHealth(getTask(paths, summary.id)));

        console.log(`Runtime: ${formatRuntime(config)}`);
        console.log(`tmux: ${isTmuxAvailable() ? "available" : "missing"}`);
        if (config.runtime.mode === "plain") {
          console.log("attach: unavailable");
          console.log("steer: unavailable");
          console.log("Fix: install tmux and run devtask config runtime attachable");
          console.log("");
        }

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
          ["PROVIDER", "ACCESS", "CLEAN", "COMMITS", "REMOTE"],
          [[remote.provider, preflight.access, preflight.clean ? "ok" : "dirty", String(preflight.commits), remote.remoteUrl]]
        );
        if (preflight.accessDetail) {
          console.log("");
          console.log(preflight.accessDetail);
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
          ["ID", "STAGE", "STATUS", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [row.id, row.stage, row.status, row.check, row.review, row.pr, row.updated, row.next])
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

  const jira = program.command("jira").description("Use Jira issues as durable devtask source inputs.");

  jira
    .command("doctor")
    .description("Check Jira configuration and environment.")
    .action(async () => {
      try {
        const paths = resolveWorkspacePaths();
        const config = readConfig(paths);
        console.log(`baseUrl: ${config.jira.baseUrl ?? "-"}`);
        console.log(`email: ${config.jira.email ?? "-"}`);
        console.log(`cloudId: ${config.jira.cloudId ?? "-"}`);
        console.log(`JIRA_API_TOKEN: ${process.env.JIRA_API_TOKEN ? "set" : "missing"}`);
        assertJiraConfigured(config);
        const auth = await checkJiraAuth(config);
        console.log(`mode: ${auth.mode}`);
        console.log(`account: ${auth.displayName ?? auth.accountId ?? "-"}`);
        console.log("Jira: authenticated");
      } catch (error) {
        printError(error);
      }
    });

  jira
    .command("fetch")
    .description("Fetch a Jira issue and write durable source artifacts.")
    .argument("<issue-key>")
    .action(async (issueKey: string) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeStore(paths);
        const issue = await fetchJiraIssue(readConfig(paths), issueKey);
        const artifacts = writeJiraSourceArtifacts(paths, issue);
        console.log(`${issue.key}: ${issue.summary}`);
        console.log(`JSON: ${artifacts.jsonPath}`);
        console.log(`Markdown: ${artifacts.markdownPath}`);
      } catch (error) {
        printError(error);
      }
    });

  jira
    .command("create")
    .description("Create a repo-local task from a Jira issue.")
    .argument("<issue-key>")
    .option("--task <task-id>", "Task id to create. Defaults to lower-case Jira key.")
    .action(async (issueKey: string, options: { task?: string }) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const issue = await fetchJiraIssue(readConfig(paths), issueKey);
        const artifacts = writeJiraSourceArtifacts(paths, issue);
        const taskId = options.task ?? defaultTaskIdForIssue(issue.key);
        const meta = await createTask(paths, taskId, {
          goal: buildJiraTaskGoal(issue, artifacts.markdownPath)
        });
        console.log(`Fetched ${issue.key}: ${issue.summary}`);
        console.log(`Source: ${artifacts.markdownPath}`);
        console.log(`Created task ${meta.id}`);
        console.log(`Branch: ${meta.branch}`);
        console.log(`Worktree: ${meta.worktreePath}`);
      } catch (error) {
        printError(error);
      }
    });

  jira
    .command("group")
    .description("Create a multi-repo group from a Jira issue.")
    .argument("<issue-key>")
    .option("--group <group-id>", "Group id to create. Defaults to lower-case Jira key.")
    .option("--repo <spec>", "Create and add a repo task as name=path:task-id", collectOption, [])
    .action(async (issueKey: string, options: { group?: string; repo: string[] }) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeWorkspace(paths);
        const issue = await fetchJiraIssue(readConfig(paths), issueKey);
        const artifacts = writeJiraSourceArtifacts(paths, issue);
        const groupId = options.group ?? defaultTaskIdForIssue(issue.key);
        const repoSpecs = parseGroupCreateRepoSpecs(options.repo);
        const plannedRepos = preflightGroupCreateRepos(paths, groupId, repoSpecs);
        const goal = buildJiraGroupGoal(issue, artifacts.markdownPath);
        const created = createGroup(paths, groupId, { goal });
        console.log(`Fetched ${issue.key}: ${issue.summary}`);
        console.log(`Source: ${artifacts.markdownPath}`);
        console.log(`Created group ${created.id}`);

        for (const repo of plannedRepos) {
          initializeStore(repo.paths);
          const meta = await createTask(repo.paths, repo.taskId, {
            goal: buildJiraGroupRepoGoal(issue, groupId, repo.name, artifacts.markdownPath)
          });
          addRepoToGroup(paths, groupId, {
            name: repo.name,
            repoPath: repo.paths.root,
            taskId: meta.id
          });
          console.log(`Added ${repo.name}`);
          console.log(`Repo: ${repo.paths.root}`);
          console.log(`Task: ${meta.id}`);
          console.log(`Worktree: ${meta.worktreePath}`);
        }
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("orchestrate")
    .description("Create or refresh the cross-repo orchestration plan for a group.")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const groupData = getGroup(paths, id);
        const config = readConfig(paths);
        console.log(`Running group orchestrator for ${groupData.id}`);
        const record = await runGroupOrchestrator(paths, groupData, config, {
          onStart: (start) => {
            console.log(`Prompt: ${start.promptPath}`);
            console.log(`Orchestration: ${start.orchestrationPath}`);
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
        console.log(`Orchestration: ${record.status}`);
        console.log(`File: ${record.orchestrationPath}`);
        if (record.status === "failed") {
          process.exit(1);
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
    .command("attach")
    .description("Attach to one repo task's tmux session in a group.")
    .argument("<id>")
    .requiredOption("--repo <repo-name>", "Repo to attach")
    .action((id: string, options: { repo: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repo = selectOneGroupRepo(paths, id, options.repo);
        const repoPaths = resolvePaths(repo.path);
        const meta = getTask(repoPaths, repo.taskId);
        const session = meta.tmuxSession ?? tmuxSessionName(repoPaths, repo.taskId);
        attachTmuxSession(session);
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("steer")
    .description("Send live feedback to one repo task in a group.")
    .argument("<id>")
    .argument("[message...]")
    .requiredOption("--repo <repo-name>", "Repo to steer")
    .option("-f, --file <path>", "Read feedback from a file")
    .option("-n, --lines <count>", "Capture this many lines after sending", parsePositiveInteger, 20)
    .option("--stage <stage>", "Steer a stage session such as plan or review")
    .action((id: string, messageParts: string[], options: { repo: string; file?: string; lines: number; stage?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repo = selectOneGroupRepo(paths, id, options.repo);
        const repoPaths = resolvePaths(repo.path);
        steerTask(repoPaths, repo.taskId, {
          messageParts,
          file: options.file,
          lines: options.lines,
          messageRoot: paths.root,
          stage: options.stage
        });
      } catch (error) {
        printError(error);
      }
    });

  group
    .command("plan")
    .description("Run planning agents for every repo task in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only plan one repo")
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
            await planTask(repoPaths, repo.taskId, { groupOrchestration: readGroupOrchestration(paths, id) });
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
    .command("fix")
    .description("Run fix agents for repo tasks in a group.")
    .argument("<id>")
    .option("--repo <repo-name>", "Only fix one repo")
    .option("--from <stage>", "Failed stage to fix", "check")
    .action(async (id: string, options: { repo?: string; from: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = selectGroupRepos(paths, id, options.repo);
        let failed = false;
        const rows: string[][] = [];

        for (const repo of repos) {
          const repoPaths = resolvePaths(repo.path);
          try {
            const request = createFixRequest(repoPaths, repo.taskId, options.from);
            const started = startWorker(repoPaths, repo.taskId, { ...resolveRunRuntime(repoPaths, {}), fix: true });
            rows.push([repo.name, repo.taskId, started.tmuxSession ? "started:tmux" : "started", `${request.source}:${request.fixId}`]);
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
          ["REPO", "TASK", "STAGE", "STATUS", "CHECK", "REVIEW", "PR", "UPDATED", "NEXT"],
          rows.map((row) => [row.repo, row.task, row.stage, row.status, row.check, row.review, row.pr, row.updated, row.next])
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
            const config = readConfig(repoPaths);
            const preflight = await preflightScmForPullRequest(meta.worktreePath, { draft: false });
            const tmuxAlive = meta.tmuxSession ? tmuxSessionExists(meta.tmuxSession) : false;
            return { repo, meta, config, preflight, tmuxAlive };
          })
        );
        printTable(
          ["REPO", "TASK", "RUNTIME", "TMUX", "ATTACH", "STEER", "PROVIDER", "ACCESS", "CLEAN", "COMMITS"],
          rows.map(({ repo, meta, config, preflight, tmuxAlive }) => [
            repo.name,
            repo.taskId,
            config.runtime.mode,
            meta.tmuxSession ?? "-",
            tmuxAlive ? "yes" : "no",
            tmuxAlive ? "yes" : "no",
            preflight.provider,
            preflight.access,
            preflight.clean ? "ok" : "dirty",
            preflight.commits > 0 ? "yes" : "no"
          ])
        );
        const details = rows.filter(({ preflight }) => preflight.accessDetail);
        if (details.length > 0) {
          console.log("");
          console.log("Details:");
          for (const { repo, preflight } of details) {
            console.log(`${repo.name}/${repo.taskId}: ${preflight.accessDetail}`);
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
          if (!["created", "planned", "paused"].includes(meta.status)) {
            console.log(`${repo.name}/${repo.taskId}: skipped (${meta.status})`);
            continue;
          }
          printStartedWorker(`${repo.name}/${repo.taskId}`, startWorker(repoPaths, repo.taskId, resolveRunRuntime(repoPaths, {})), "Running");
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
    .option("--attachable", "Run the review agent inside an attachable tmux session")
    .option("--tmux", "Alias for --attachable")
    .option("--plain", "Run in the current foreground process")
    .action(async (id: string, options: { attachable?: boolean; tmux?: boolean; plain?: boolean }) => {
      try {
        const paths = resolvePaths();
        assertReviewReady(paths, getTask(paths, id), readConfig(paths));
        if (startStageSessionIfRequested(paths, id, "review", ["review", id, "--plain"], options)) {
          return;
        }
        await reviewAction(id);
      } catch (error) {
        printError(error);
      }
    });

  program
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

  program
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

        const started = startWorker(paths, id, meta.tmuxSession ? { tmux: true } : resolveRunRuntime(paths, {}));
        printStartedWorker(id, started, "Continuing");
      } catch (error) {
        printError(error);
      }
    });

  program
    .command("steer")
    .description("Send live feedback to a running attachable task session.")
    .argument("<id>")
    .argument("[message...]")
    .option("-f, --file <path>", "Read feedback from a file")
    .option("-n, --lines <count>", "Capture this many lines after sending", parsePositiveInteger, 20)
    .option("--stage <stage>", "Steer a stage session such as plan or review")
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

  program
    .command("attach")
    .description("Attach to a task tmux session.")
    .argument("<id>")
    .option("--stage <stage>", "Attach to a stage session such as plan or review")
    .action((id: string, options: { stage?: string }) => {
      try {
        const paths = resolvePaths();
        const meta = getTask(paths, id);
        const session = options.stage ? stageTmuxSessionName(paths, id, options.stage) : meta.tmuxSession ?? tmuxSessionName(paths, id);
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

  return program;
}

interface StartedWorker {
  pid: number | null;
  tmuxSession: string | null;
}

function printStartedWorker(id: string, started: StartedWorker, verb: "Running" | "Continuing" | "Fixing"): void {
  console.log(`${verb} task ${id}`);
  if (started.tmuxSession) {
    console.log(`tmux: ${started.tmuxSession}`);
    console.log(`Attach: devtask attach ${id}`);
    console.log(`Steer: devtask steer ${id} "message"`);
    return;
  }
  console.log("Runtime: plain (attach/steer unavailable)");
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

function configureRuntimeFromEnvironment(paths: ReturnType<typeof resolvePaths>): void {
  const current = readConfig(paths);
  if (isTmuxAvailable()) {
    writeConfig(paths, {
      ...current,
      runtime: {
        mode: "attachable",
        backend: "tmux"
      },
      runtimeConfigured: true
    });
    console.log("Runtime: attachable (tmux)");
    return;
  }

  writeConfig(paths, {
    ...current,
    runtime: {
      mode: "plain",
      backend: null
    },
    runtimeConfigured: true
  });
  console.log("Runtime: plain");
  console.log("tmux is not installed. devtask can still run tasks in plain background mode, but attach and steer will not be available.");
  console.log("Install tmux, then run: devtask config runtime attachable");
}

function parseRuntimeMode(mode: string): ReturnType<typeof readConfig>["runtime"] {
  if (mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is not available. Install tmux before enabling attachable runtime.");
    }
    return {
      mode: "attachable",
      backend: "tmux"
    };
  }

  if (mode === "plain") {
    return {
      mode: "plain",
      backend: null
    };
  }

  throw new DevtaskError('Invalid runtime mode. Use "attachable" or "plain".');
}

function formatRuntime(config: ReturnType<typeof readConfig>): string {
  return config.runtime.mode === "attachable" ? "attachable (tmux)" : "plain";
}

function resolveRunRuntime(
  paths: ReturnType<typeof resolvePaths>,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): { tmux: boolean } {
  const requestedAttachable = options.attachable === true || options.tmux === true;
  if (options.plain === true && requestedAttachable) {
    throw new DevtaskError("Use either --attachable/--tmux or --plain, not both");
  }

  if (options.plain === true) {
    warnPlainRuntime();
    return { tmux: false };
  }

  const config = readConfig(paths);
  if (requestedAttachable || config.runtime.mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is required for attachable sessions. Install tmux or run devtask run <id> --plain.");
    }
    return { tmux: true };
  }

  warnPlainRuntime();
  return { tmux: false };
}

function startStageSessionIfRequested(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  stage: string,
  args: string[],
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): boolean {
  if (!resolveStageAttachable(paths, options)) {
    return false;
  }

  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new DevtaskError("Unable to determine devtask CLI path for attachable stage session");
  }

  const session = stageTmuxSessionName(paths, id, stage);
  startTmuxSession(session, [process.execPath, cliPath, ...args], paths.root);
  console.log(`Started ${stage} in tmux: ${session}`);
  console.log(`Attach: tmux attach -t ${shellQuote(session)}`);
  return true;
}

function resolveStageAttachable(
  paths: ReturnType<typeof resolvePaths>,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): boolean {
  const requestedAttachable = options.attachable === true || options.tmux === true;
  if (options.plain === true && requestedAttachable) {
    throw new DevtaskError("Use either --attachable/--tmux or --plain, not both");
  }
  if (options.plain === true) {
    return false;
  }

  const config = readConfig(paths);
  if (requestedAttachable || config.runtime.mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is required for attachable stage sessions. Install tmux or use --plain.");
    }
    return true;
  }
  return false;
}

function stageTmuxSessionName(paths: ReturnType<typeof resolvePaths>, id: string, stage: string): string {
  return `${tmuxSessionName(paths, id)}-${stage.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function killTaskStageSessions(paths: ReturnType<typeof resolvePaths>, id: string): void {
  if (!isTmuxAvailable()) {
    return;
  }

  for (const stage of STAGE_NAMES) {
    killTmuxSession(stageTmuxSessionName(paths, id, stage));
  }
}

function warnPlainRuntime(): void {
  console.log("Warning: running in plain mode. attach/steer will not be available.");
  console.log("Install tmux and run: devtask config runtime attachable");
}

function readSteerMessage(root: string, filePath: string | undefined, messageParts: string[]): string {
  if (filePath && messageParts.length > 0) {
    throw new DevtaskError("Use either --file or an inline message, not both");
  }

  if (filePath) {
    const resolved = path.resolve(root, filePath);
    if (!fs.existsSync(resolved)) {
      throw new DevtaskError(`Feedback file does not exist: ${resolved}`);
    }
    const content = fs.readFileSync(resolved, "utf8").trim();
    if (!content) {
      throw new DevtaskError(`Feedback file is empty: ${resolved}`);
    }
    return content;
  }

  const message = messageParts.join(" ").trim();
  if (!message) {
    throw new DevtaskError("No feedback message provided");
  }
  return message;
}

function steerTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { messageParts: string[]; file?: string; lines: number; messageRoot?: string; stage?: string }
): void {
  const meta = getTask(paths, id);
  const session = options.stage ? stageTmuxSessionName(paths, id, options.stage) : meta.tmuxSession;
  if (!session) {
    throw new DevtaskError(`Task ${id} is not running in an attachable session. Use devtask run ${id} after configuring attachable runtime.`);
  }
  const message = readSteerMessage(options.messageRoot ?? paths.root, options.file, options.messageParts);
  const result = sendToTmuxSessionWithConfirmation(session, message, { lines: options.lines });
  console.log(result.confirmed ? "Message sent; terminal output changed" : "Message sent; no terminal change observed yet");
  if (result.output.trim()) {
    console.log("");
    console.log(result.output.trimEnd());
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

function printWorkspaceTargets(targets: WorkspaceTarget[]): void {
  printTable(
    ["ID", "KIND", "REPO", "SCOPE"],
    targets.map((target) => [target.id, target.kind ?? "-", target.repoPath, target.scope ?? "."])
  );
}

function printWorkItems(items: WorkItem[]): void {
  printTable(
    ["ID", "STATUS", "SOURCE", "TITLE", "UPDATED"],
    items.map((item) => [
      item.id,
      item.status,
      item.source.type,
      item.source.title,
      item.updatedAt
    ])
  );
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

function defaultTaskIdForIssue(issueKey: string): string {
  return issueKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function buildJiraGroupGoal(issue: JiraIssue, sourcePath: string): string {
  return [
    `Implement Jira issue ${issue.key}: ${issue.summary}`,
    "",
    `Jira source artifact: ${sourcePath}`,
    `Jira URL: ${issue.url}`,
    "",
    "This is a multi-repo devtask group. Each repo task should inspect its own repository, implement only its scoped part, and keep changes aligned with the Jira issue.",
    "",
    "## Jira Issue",
    "",
    renderJiraIssueMarkdown(issue).trim()
  ].join("\n");
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

function getMaterializedWorkTasks(paths: ReturnType<typeof resolvePaths>, item: WorkItem): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    throw new DevtaskError(`Work item ${item.id} has not been materialized. Run devtask work approve-plan ${item.id} first.`);
  }
  return materialization.tasks;
}

function selectWorkTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  target?: string
): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  const tasks = getMaterializedWorkTasks(paths, item);
  const selected = target ? tasks.filter((task) => task.target === target) : tasks;
  if (selected.length === 0) {
    throw new DevtaskError(target ? `Work item ${item.id} does not have target ${target}` : `Work item ${item.id} has no materialized tasks`);
  }
  return selected;
}

function getWorkWorkflowUnits(paths: ReturnType<typeof resolvePaths>, item: WorkItem, target?: string): WorkflowUnit[] {
  return selectWorkTasks(paths, item, target).map((task) => ({
    target: task.target,
    taskId: task.taskId,
    repoPath: task.repoPath
  }));
}

function selectWorkLogTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  target?: string
): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  return selectWorkTasks(paths, item, target);
}

function resolveRequestedLogStage(stage: LogStage, target: string, taskId: string, boardRows: WorkBoardRow[]): LogStage {
  if (stage !== "current") {
    return stage;
  }
  const row = boardRows.find((candidate) => candidate.target === target && candidate.task === taskId);
  if (row?.stage === "run" || row?.stage === "check" || row?.stage === "review") {
    return row.stage;
  }
  if (row?.stage === "fix") {
    return "check";
  }
  return "latest";
}

async function runWorkWorkflowStage(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  stage: WorkflowStageId,
  target: string | undefined,
  run: (unit: WorkflowUnit) => Promise<{ status: "passed" | "failed" | "skipped" | "started"; detail: string }>
): Promise<Awaited<ReturnType<typeof runWorkflowStage>>> {
  return runWorkflowStage(DEFAULT_DEV_WORKFLOW, getWorkWorkflowUnits(paths, item, target), {
    stage,
    run
  });
}

function printWorkflowStageResult(headers: [string, string, string, string], result: Awaited<ReturnType<typeof runWorkflowStage>>): void {
  printTable(
    headers,
    result.results.map((row) => [row.unit.target, row.unit.taskId, row.status, row.detail])
  );
}

function createFixRequest(paths: ReturnType<typeof resolvePaths>, taskId: string, source: string): ReturnType<typeof createFixRequestFromCheck> {
  const meta = getTask(paths, taskId);
  if (source === "check") {
    return createFixRequestFromCheck(paths, meta);
  }
  throw new DevtaskError(`Fix source ${source} is not supported yet. Supported sources: check`);
}

async function runWorkRepoPlans(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<Array<{ target: string; taskId: string; repoPath: string; planPath: string; status: string }>> {
  const tasks = getMaterializedWorkTasks(paths, item);
  const results: Array<{ target: string; taskId: string; repoPath: string; planPath: string; status: string }> = [];
  for (const task of tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = getTask(repoPaths, task.taskId);
    if (!["created", "planned", "blocked"].includes(meta.status)) {
      throw new DevtaskError(`Task ${task.taskId} is ${meta.status}; repo planning is only available before the task runs`);
    }

    if (!options.refresh && meta.status === "planned" && hasTaskPlan(repoPaths, task.taskId)) {
      results.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath: planMarkdownPath(repoPaths, task.taskId),
        status: "existing"
      });
      continue;
    }

    console.log(`${task.target}/${task.taskId}`);
    if (startStageSessionIfRequested(repoPaths, task.taskId, "plan", ["plan", task.taskId, "--plain"], options)) {
      results.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath: planMarkdownPath(repoPaths, task.taskId),
        status: "started"
      });
      continue;
    }
    await planTask(repoPaths, task.taskId);
    results.push({
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      planPath: planMarkdownPath(repoPaths, task.taskId),
      status: "planned"
    });
  }
  return results;
}

async function runReadyWorkTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<void> {
  const plan = planWorkRun(paths, item);
  for (const task of plan.skipped) {
    console.log(`${task.target}/${task.taskId}: skipped (${task.reason})`);
  }
  const result = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, plan.ready, {
    stage: "run",
    run: async (task) => {
      const repoPaths = resolvePaths(task.repoPath);
      const runtime = resolveRunRuntime(repoPaths, options);
      printStartedWorker(`${task.target}/${task.taskId}`, startWorker(repoPaths, task.taskId, runtime), "Running");
      return { status: "started", detail: "worker started" };
    }
  });
  if (workflowStageFailed(result)) {
    printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
    throw new DevtaskError(`Work run ${item.id} failed to start one or more ready tasks.`);
  }
  if (plan.ready.length === 0 && plan.skipped.length === 0) {
    console.log(`No materialized tasks for work item ${item.id}`);
  }
}

async function followWorkRun(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean; poll: number }
): Promise<void> {
  const intervalMs = options.poll * 1000;
  const announcedWaiting = new Set<string>();
  console.log(`Following work run ${item.id}`);

  while (true) {
    throwIfWorkRunFailed(paths, item);
    const plan = planWorkRun(paths, item);
    const startResult = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, plan.ready, {
      stage: "run",
      run: async (task) => {
        const repoPaths = resolvePaths(task.repoPath);
        const runtime = resolveRunRuntime(repoPaths, options);
        printStartedWorker(`${task.target}/${task.taskId}`, startWorker(repoPaths, task.taskId, runtime), "Running");
        return { status: "started", detail: "worker started" };
      }
    });
    if (workflowStageFailed(startResult)) {
      printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], startResult);
      throw new DevtaskError(`Work run ${item.id} failed to start one or more ready tasks.`);
    }

    for (const task of plan.skipped) {
      const key = `${task.target}/${task.taskId}:${task.reason}`;
      if (!announcedWaiting.has(key)) {
        announcedWaiting.add(key);
        console.log(`${task.target}/${task.taskId}: waiting (${task.reason})`);
      }
    }

    if (isWorkRunComplete(paths, item)) {
      console.log(`Work run ${item.id} complete`);
      return;
    }

    if (plan.ready.length === 0 && !hasRunningMaterializedTask(paths, item)) {
      throw new DevtaskError(`Work run ${item.id} cannot advance. Inspect with devtask work board ${item.id}.`);
    }

    await sleep(intervalMs);
  }
}

function throwIfWorkRunFailed(paths: ReturnType<typeof resolvePaths>, item: WorkItem): void {
  const failed = getMaterializedWorkTasks(paths, item)
    .map((task) => ({ task, meta: getTask(resolvePaths(task.repoPath), task.taskId) }))
    .find(({ meta }) => meta.status === "failed" || meta.status === "blocked" || meta.status === "cancelled");
  if (failed) {
    throw new DevtaskError(`${failed.task.target}/${failed.task.taskId} is ${failed.meta.status}. Inspect with devtask work board ${item.id}.`);
  }
}

function isWorkRunComplete(paths: ReturnType<typeof resolvePaths>, item: WorkItem): boolean {
  const tasks = getMaterializedWorkTasks(paths, item);
  return tasks.length > 0 && tasks.every((task) => isWorkTaskRunComplete(resolvePaths(task.repoPath), task.taskId));
}

function hasRunningMaterializedTask(paths: ReturnType<typeof resolvePaths>, item: WorkItem): boolean {
  return getMaterializedWorkTasks(paths, item).some((task) => {
    const meta = getTask(resolvePaths(task.repoPath), task.taskId);
    return meta.status === "running" || isProcessAlive(meta.supervisorPid);
  });
}

function existingWorkPlanArtifacts(paths: ReturnType<typeof resolvePaths>, id: string): boolean {
  return fs.existsSync(workPlanPath(paths, id)) && fs.existsSync(workGraphPath(paths, id));
}

function printExistingWorkPlan(paths: ReturnType<typeof resolvePaths>, id: string): void {
  console.log(`Work item ${id} already has a plan.`);
  console.log(`Plan: ${workPlanPath(paths, id)}`);
  console.log(`Graph: ${workGraphPath(paths, id)}`);
  console.log("");
  console.log(`Next: devtask work approve-plan ${shellQuote(id)}`);
  console.log(`Use --refresh to regenerate the plan before approval.`);
}

function printMaterializedWorkPlan(paths: ReturnType<typeof resolvePaths>, id: string, taskCount: number): void {
  console.log(`Work item ${id} has already been materialized.`);
  console.log(`Plan: ${workPlanPath(paths, id)}`);
  console.log(`Graph: ${workGraphPath(paths, id)}`);
  console.log(`Materialized tasks: ${taskCount}`);
  console.log("");
  console.log(`Next: devtask work board ${shellQuote(id)}`);
  console.log(`Use cleanup before replanning from scratch.`);
}

function printGroupLog(
  repoName: string,
  repoPath: string,
  taskId: string,
  options: { lines: number; follow: boolean }
): void {
  printMaterializedTaskLog(`${repoName}/${taskId}`, repoPath, taskId, options);
}

function printWorkLog(
  target: string,
  repoPath: string,
  taskId: string,
  options: { stage: LogStage; lines: number; follow: boolean }
): void {
  printStageTaskLog(`${target}/${taskId}`, repoPath, taskId, options);
}

function printMaterializedTaskLog(
  label: string,
  repoPath: string,
  taskId: string,
  options: { lines: number; follow: boolean }
): void {
  const repoPaths = resolvePaths(repoPath);
  getTask(repoPaths, taskId);
  const logPath = readLatestLogPath(repoPaths, taskId);
  if (!logPath) {
    console.log(`${label}: no logs`);
    return;
  }

  console.log(label);
  console.log(`Log: ${logPath}`);
  if (options.follow) {
    followFile(logPath, options.lines);
    return;
  }

  console.log(tailFile(logPath, options.lines));
}

function printStageTaskLog(
  label: string,
  repoPath: string,
  taskId: string,
  options: { stage: LogStage; lines: number; follow: boolean }
): void {
  const repoPaths = resolvePaths(repoPath);
  const review = readTaskLogArtifacts(repoPaths, taskId);
  const stage = options.stage === "latest" || options.stage === "current" ? latestLogStage(review) : options.stage;
  if (!stage) {
    console.log(`${label}: no stage logs`);
    return;
  }

  if (stage === "run") {
    if (!review.latestRun) {
      console.log(`${label}: no run logs`);
      return;
    }
    printFileLog(`${label} run`, review.latestRun.logPath, options);
    return;
  }

  if (stage === "review") {
    if (!review.latestReviewAgent) {
      console.log(`${label}: no review logs`);
      return;
    }
    printFileLog(`${label} review`, review.latestReviewAgent.outputPath, options);
    return;
  }

  if (!review.latestVerification) {
    console.log(`${label}: no check logs`);
    return;
  }
  if (options.follow) {
    console.log(`${label} check`);
    console.log("Check output is complete; printing the latest captured verification output instead of following.");
    printVerificationOutput(review.latestVerification, options.lines);
    return;
  }

  console.log(`${label} check`);
  printVerificationOutput(review.latestVerification, options.lines);
}

function printFileLog(label: string, filePath: string, options: { lines: number; follow: boolean }): void {
  if (!fs.existsSync(filePath)) {
    console.log(`${label}: missing log file ${filePath}`);
    return;
  }

  console.log(label);
  console.log(`Log: ${filePath}`);
  if (options.follow) {
    followFile(filePath, options.lines);
    return;
  }
  console.log(tailFile(filePath, options.lines));
}

interface TaskLogArtifacts {
  latestRun: ReturnType<typeof readLatestRun>;
  latestVerification: VerificationRecord | null;
  latestReviewAgent: ReviewAgentRecord | null;
}

function readTaskLogArtifacts(repoPaths: ReturnType<typeof resolvePaths>, taskId: string): TaskLogArtifacts {
  getTask(repoPaths, taskId);
  return {
    latestRun: readLatestRun(repoPaths, taskId),
    latestVerification: readLatestVerification(repoPaths, taskId),
    latestReviewAgent: readLatestReviewAgent(repoPaths, taskId)
  };
}

function latestLogStage(review: TaskLogArtifacts): Exclude<LogStage, "current" | "latest"> | null {
  const candidates: Array<{ stage: Exclude<LogStage, "current" | "latest">; at: string }> = [];
  if (review.latestRun) {
    candidates.push({ stage: "run", at: review.latestRun.finishedAt });
  }
  if (review.latestVerification) {
    candidates.push({ stage: "check", at: review.latestVerification.finishedAt });
  }
  if (review.latestReviewAgent) {
    candidates.push({ stage: "review", at: review.latestReviewAgent.finishedAt });
  }
  candidates.sort((a, b) => a.at.localeCompare(b.at));
  return candidates.at(-1)?.stage ?? null;
}

function printVerificationOutput(verification: VerificationRecord, lines: number): void {
  console.log(`Status: ${verification.status}`);
  console.log(`Started: ${verification.startedAt}`);
  console.log(`Finished: ${verification.finishedAt}`);
  console.log("");
  console.log("Steps:");
  for (const step of verification.steps) {
    console.log(`  ${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
  }
  const output = renderVerificationOutput(verification);
  if (output) {
    console.log("");
    console.log(tailText(output, lines));
  }
}

function renderVerificationOutput(verification: VerificationRecord): string {
  return verification.steps
    .map((step) =>
      [
        `${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`,
        step.stdout ? `stdout:\n${step.stdout.trimEnd()}` : "",
        step.stderr ? `stderr:\n${step.stderr.trimEnd()}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
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
  recordStage(paths, id, "approve", {
    status: "passed",
    input: {
      force: options.force,
      issues
    },
    output: {
      approved: true,
      forced: issues.length > 0
    },
    reason: issues.length > 0 ? `forced: ${issues.join("; ")}` : null
  });
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
    }
  }

  if (!review.latestReviewAgent) {
    issues.push("review missing");
  } else if (review.latestReviewAgent.status !== "passed") {
    issues.push(`review ${review.latestReviewAgent.status}`);
  }

  // TODO(stage-contract): add a real content-change baseline before enforcing stale artifact checks.
  // `meta.updatedAt` tracks metadata updates, not necessarily code/worktree changes.
  return issues;
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

function selectOneGroupRepo(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  repoName: string
): ReturnType<typeof getGroup>["repos"][number] {
  return selectGroupRepos(paths, id, repoName)[0]!;
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
  stage: string;
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
    ["REPO", "TASK", "STATUS", "PROVIDER", "ACCESS", "CLEAN", "COMMITS", "MODE", "PR"],
    rows.map(({ repo, meta, preflight }) => [
      repo.name,
      repo.taskId,
      meta.status,
      preflight.provider,
      preflight.access,
      preflight.clean ? "ok" : "dirty",
      preflight.commits > 0 ? "yes" : "no",
      mode === "draft" && !preflight.draftSupported ? "unsupported" : mode,
      meta.prUrl ? "open" : "-"
    ])
  );
  const details = rows.filter(({ preflight }) => preflight.accessDetail);
  if (details.length > 0) {
    console.log("");
    console.log("Preflight details:");
    for (const { repo, preflight } of details) {
      console.log(`${repo.name}/${repo.taskId}: ${preflight.accessDetail}`);
    }
  }
  console.log("");
}

function printWorkPrPreflight(
  rows: Array<{ task: NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"][number]; meta: ReturnType<typeof getTask>; preflight: ScmPreflight }>,
  mode: string
): void {
  console.log("Preflight:");
  printTable(
    ["TARGET", "TASK", "STATUS", "LIFECYCLE", "PROVIDER", "ACCESS", "CLEAN", "COMMITS", "MODE", "PR"],
    rows.map(({ task, meta, preflight }) => [
      task.target,
      task.taskId,
      meta.status,
      isWorkPrLifecycleReady(meta) ? "ok" : "blocked",
      preflight.provider,
      preflight.access,
      preflight.clean ? "ok" : "dirty",
      preflight.commits > 0 ? "yes" : "no",
      mode === "draft" && !preflight.draftSupported ? "unsupported" : mode,
      meta.prUrl ? "open" : "-"
    ])
  );
  const details = rows.filter(({ preflight }) => preflight.accessDetail);
  if (details.length > 0) {
    console.log("");
    console.log("Preflight details:");
    for (const { task, preflight } of details) {
      console.log(`${task.target}/${task.taskId}: ${preflight.accessDetail}`);
    }
  }
  console.log("");
}

function isPrPreflightReady(meta: ReturnType<typeof getTask>, preflight: ScmPreflight, draft: boolean): boolean {
  if (meta.status === "pr-open" && meta.prUrl) {
    return true;
  }
  return preflight.access === "ok" && preflight.clean && preflight.commits > 0 && (!draft || preflight.draftSupported);
}

function isWorkPrPreflightReady(meta: ReturnType<typeof getTask>, preflight: ScmPreflight, draft: boolean): boolean {
  if (meta.status === "pr-open" && meta.prUrl) {
    return true;
  }
  return isWorkPrLifecycleReady(meta) && isPrPreflightReady(meta, preflight, draft);
}

function isWorkPrLifecycleReady(meta: ReturnType<typeof getTask>): boolean {
  return meta.status === "approved" || meta.status === "ci-failed" || (meta.status === "pr-open" && Boolean(meta.prUrl));
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
      stage: row.stage,
      status: row.status,
      check: row.check,
      review: row.review,
      pr: row.pr,
      updated: row.updated,
      next: rewriteCommandForGroup(row.next, id, repo.name, repo.path)
    });
  }

  return rows;
}

function rewriteCommandForGroup(command: string, groupId: string, repoName: string, repoPath: string): string {
  const parts = command.split(" ");
  const action = parts[1];
  if (parts[0] !== "devtask" || !action) {
    return command;
  }

  if (["plan", "check", "fix", "review", "approve", "commit", "pr"].includes(action)) {
    return `devtask group ${action} ${shellQuote(groupId)} --repo ${shellQuote(repoName)}`;
  }

  if (action === "run") {
    return `devtask group run ${shellQuote(groupId)}`;
  }

  return rewriteCommandForRepo(command, repoPath);
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
    case "plan":
      await planTask(paths, id);
      return;
    case "run":
      printStartedWorker(id, startWorker(paths, id, resolveRunRuntime(paths, {})), "Running");
      return;
    case "continue": {
      const meta = getTask(paths, id);
      printStartedWorker(id, startWorker(paths, id, meta.tmuxSession ? { tmux: true } : resolveRunRuntime(paths, {})), "Continuing");
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

async function planTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { groupOrchestration?: string | null } = {}
): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before planning`);
  }
  if (["approved", "pr-open", "ci-running", "ci-failed", "ci-passed", "done", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${id} is ${meta.status}; planning is only available before approval and publishing`);
  }

  const config = readConfig(paths);
  const record = await runStage(paths, id, "plan", {
    input: {
      taskPath: meta.taskPath,
      worktreePath: meta.worktreePath,
      model: meta.model ?? config.codex.model
    },
    artifacts: [planMarkdownPath(paths, id)]
  }, async () => {
    console.log(`Running planning agent in ${meta.worktreePath}`);
    const planRecord = await runPlanAgent(paths, meta, {
      model: meta.model ?? config.codex.model,
      fullAuto: config.codex.fullAuto,
      groupOrchestration: options.groupOrchestration,
      onStart: (start) => {
        console.log(`Prompt: ${start.promptPath}`);
        console.log(`Plan: ${start.planPath}`);
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
    return {
      result: planRecord,
      final: {
        status: planRecord.worktreeChanged ? "failed" : planRecord.status === "planned" ? "passed" : planRecord.status,
        output: {
          planId: planRecord.planId,
          exitCode: planRecord.exitCode,
          worktreeChanged: planRecord.worktreeChanged,
          planPath: planRecord.planPath,
          outputPath: planRecord.outputPath
        },
        artifacts: [planRecord.planPath, planRecord.outputPath],
        reason: planRecord.worktreeChanged ? "planning changed the task worktree" : planRecord.status === "failed" ? "planning agent failed" : null
      }
    };
  });
  console.log(`Plan: ${record.status}`);
  console.log(`File: ${record.planPath}`);
  if (record.worktreeChanged) {
    throw new DevtaskError("Planning changed the task worktree. Revert those changes or inspect them before continuing.");
  }
  if (record.status === "failed") {
    process.exit(1);
  }
}

async function checkTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { exitOnFailure: boolean; verbose?: boolean }
): Promise<VerificationRecord> {
  const meta = getTask(paths, id);
  assertCheckReady(paths, meta);

  const config = readConfig(paths);
  if (config.verify.length === 0) {
    throw new DevtaskError("No check commands configured. Use devtask config check <command...>");
  }

  if (options.verbose !== false) {
    console.log(`Running ${config.verify.length} check command${config.verify.length === 1 ? "" : "s"} in ${meta.worktreePath}`);
  }
  const record = await runStage(paths, id, "check", {
    input: {
      commands: config.verify,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    const verificationRecord = await runVerification(paths, meta, config.verify, {
      onStepStart: (command, index, total) => {
        if (options.verbose !== false) {
          console.log(`[${index}/${total}] ${command}`);
        }
      }
    });
    return {
      result: verificationRecord,
      final: {
        status: verificationRecord.status,
        output: {
          verificationId: verificationRecord.verificationId,
          steps: verificationRecord.steps.map((step) => ({
            command: step.command,
            exitCode: step.exitCode
          }))
        },
        reason: verificationRecord.status === "failed" ? "one or more check commands failed" : null
      }
    };
  });
  if (options.verbose === false) {
    return record;
  }

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
  return record;
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
  assertReviewReady(paths, meta, config);
  console.log(`Running review agent in ${meta.worktreePath}`);
  const record = await runStage(paths, id, "review", {
    input: {
      worktreePath: meta.worktreePath,
      model: meta.model ?? config.codex.model,
      planPath: planMarkdownPath(paths, id)
    }
  }, async () => {
    const reviewRecord = await runReviewAgent(paths, meta, {
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
    return {
      result: reviewRecord,
      final: {
        status: reviewRecord.status,
        output: {
          reviewId: reviewRecord.reviewId,
          exitCode: reviewRecord.exitCode,
          outputPath: reviewRecord.outputPath
        },
        artifacts: [reviewRecord.outputPath],
        reason: reviewRecord.status === "passed" ? null : `review agent ${reviewRecord.status}`
      }
    };
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
  assertPrReady(meta);

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

  const prUrl = await runStage(paths, id, "pr", {
    input: {
      title: options.title ?? meta.id,
      draft,
      commitCount,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    const openedPrUrl = await createPullRequest(meta, {
      title: options.title ?? meta.id,
      body: options.body ?? defaultPrBody(meta),
      draft
    });

    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      status: "pr-open",
      prUrl: openedPrUrl,
      updatedAt: new Date().toISOString()
    });
    return {
      result: openedPrUrl,
      final: {
        status: "passed",
        output: {
          prUrl: openedPrUrl,
          draft
        }
      }
    };
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
  assertCommitReady(paths, meta);

  await runCommandOrThrow("git", ["add", "-A"], { cwd: meta.worktreePath });
  const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: meta.worktreePath });
  if (staged.exitCode === 0) {
    recordStage(paths, id, "commit", {
      status: "skipped",
      input: {
        worktreePath: meta.worktreePath
      },
      reason: "no staged changes"
    });
    console.log(`No changes to commit for ${id}`);
    return;
  }

  const message = options.message ?? meta.id;
  await runStage(paths, id, "commit", {
    input: {
      message,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    await runCommandOrThrow("git", ["commit", "-m", message], { cwd: meta.worktreePath });
    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      updatedAt: new Date().toISOString()
    });
    return {
      result: undefined,
      final: {
        status: "passed",
        output: {
          message
        }
      }
    };
  });
  console.log(`Committed ${id}`);
}

async function checkCiForTask(paths: ReturnType<typeof resolvePaths>, id: string): Promise<void> {
  const meta = getTask(paths, id);
  assertCiReady(meta);

  const result = await checkProviderCi(meta.worktreePath, meta.prUrl, meta.branch);
  console.log(`${result.provider}: ${result.detail}`);
  if (result.url) {
    console.log(result.url);
  }

  const status = result.status === "passed" ? "ci-passed" : "ci-failed";
  recordStage(paths, id, "ci", {
    status: result.status,
    input: {
      prUrl: meta.prUrl,
      branch: meta.branch
    },
    output: {
      provider: result.provider,
      detail: result.detail,
      url: result.url
    },
    reason: result.status === "passed" ? null : "CI check failed"
  });
  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    status,
    updatedAt: new Date().toISOString()
  });
}

function startWorker(paths: ReturnType<typeof resolvePaths>, id: string, options: { tmux?: boolean; fix?: boolean } = {}): StartedWorker {
  const meta = getTask(paths, id);
  if (options.fix) {
    assertFixReady(meta);
  } else {
    assertRunReady(meta);
  }
  if (isProcessAlive(meta.supervisorPid)) {
    throw new DevtaskError(`Task ${id} is already supervised by PID ${meta.supervisorPid}`);
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
  const runInput = {
    command: meta.command,
    worktreePath: meta.worktreePath,
    mode: options.tmux ? "attachable" : "plain",
    tmuxSession: next.tmuxSession
  };
  recordStage(paths, id, "run", {
    status: "running",
    input: runInput
  });

  const rollbackStartFailure = (error: unknown): never => {
    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      updatedAt: new Date().toISOString()
    });
    recordStage(paths, id, "run", {
      status: "failed",
      input: runInput,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  };

  const workerPath = fileURLToPath(new URL("./bin/devtask-worker.js", import.meta.url));
  const workerCommand = [process.execPath, workerPath, id, "--root", paths.root];

  if (options.tmux) {
    const session = next.tmuxSession;
    if (!session) {
      return rollbackStartFailure(new DevtaskError("Unable to derive tmux session name"));
    }

    try {
      startTmuxSession(session, workerCommand, paths.root);
    } catch (error) {
      rollbackStartFailure(error);
    }
    return { pid: null, tmuxSession: session };
  }

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [workerPath, id, "--root", paths.root], {
      cwd: paths.root,
      detached: true,
      stdio: "ignore"
    });
  } catch (error) {
    rollbackStartFailure(error);
  }

  const startedChild = child;
  if (!startedChild || startedChild.pid === undefined) {
    return rollbackStartFailure(new DevtaskError("Failed to start worker process"));
  }
  const childPid: number = startedChild.pid;
  startedChild.once("error", (error) => {
    const current = getTask(paths, id);
    if (current.status === "running" && current.supervisorPid === childPid) {
      writeTaskMeta(taskMetaPath(paths, id), {
        ...meta,
        updatedAt: new Date().toISOString()
      });
    }
    recordStage(paths, id, "run", {
      status: "failed",
      input: runInput,
      reason: error.message
    });
  });
  startedChild.unref();

  writeTaskMeta(taskMetaPath(paths, id), {
    ...next,
    supervisorPid: childPid,
    tmuxSession: null,
    updatedAt: new Date().toISOString()
  });

  return { pid: childPid, tmuxSession: null };
}

function assertFixReady(meta: ReturnType<typeof getTask>): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is already running.`);
  }
  if (["approved", "pr-open", "ci-running", "ci-passed", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${meta.id} is ${meta.status} and cannot be fixed.`);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DevtaskError("Expected a positive integer");
  }
  return parsed;
}

function parseLogStage(value: string): LogStage {
  if (value === "current" || value === "latest" || value === "run" || value === "check" || value === "review") {
    return value;
  }
  throw new DevtaskError(`Expected log stage current, latest, run, check, or review; got ${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailFile(filePath: string, lineCount: number): string {
  const content = fs.readFileSync(filePath, "utf8");
  return tailText(content, lineCount);
}

function tailText(content: string, lineCount: number): string {
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
