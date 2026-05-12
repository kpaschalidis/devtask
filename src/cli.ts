import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import {
  planMarkdownPath,
  resolvePaths,
  resolveWorkspacePaths,
  resolveWorkspacePathsForInit,
  scriptsDir,
  taskMetaPath
} from "./paths.js";
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
import { readStageLedger, recordStage, runStage, STAGE_NAMES, type StageName } from "./stage-contracts.js";
import { assertCheckReady, assertCiReady, assertCommitReady, assertPrReady, assertReviewReady, assertRunReady } from "./stage-policy.js";
import {
  assertJiraConfigured,
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
import { cleanupWorkItem } from "./work-cleanup.js";
import { registerTaskCommands } from "./cli/task.js";
import { registerJiraCommands } from "./cli/jira.js";
import {
  approveTask,
  checkCiForTask,
  checkTask,
  commitTask,
  configureRuntimeFromEnvironment,
  createFixRequest,
  defaultTaskIdForIssue,
  existingWorkPlanArtifacts,
  followWorkRun,
  formatRuntime,
  followFile,
  installTemplateScripts,
  installedScriptPath,
  listTemplateScripts,
  markTask,
  normalizeCleanupOptions,
  killTaskStageSessions,
  openPrForTask,
  parseLogStage,
  parsePositiveInteger,
  parseRuntimeMode,
  planTask,
  printCleanupPlan,
  printError,
  printExistingWorkPlan,
  printMaterializedWorkPlan,
  printNextAction,
  printPrPreflightBlockers,
  printStartedWorker,
  printTable,
  printWorkflowStageResult,
  printWorkItems,
  printWorkLog,
  printWorkPrPreflight,
  printWorkSummary,
  printWorkspaceTargets,
  resolveAttachSession,
  resolvePrDraftMode,
  resolveRequestedLogStage,
  resolveRunRuntime,
  reviewTask,
  runReadyWorkTasks,
  runWorkRepoPlans,
  runWorkWorkflowStage,
  selectOneWorkTask,
  selectWorkLogTasks,
  selectWorkTasks,
  startStageSessionIfRequested,
  tailFile,
  templateScriptPath,
  startWorker,
  steerTask,
  workflowCiStatus,
  workPrPreflightBlockers,
  type LogStage,
  type PrOptions
} from "./cli/support.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("devtask")
    .description("Local persistent task workers for agent-driven development.")
    .version("1.0.0");

  program
    .command("init")
    .description("Initialize devtask storage in the current git repository or workspace.")
    .option("--workspace", "Initialize a non-git workspace for work-item orchestration and helper scripts")
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
    .option("--json", "Print raw work item metadata JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        if (options.json) {
          console.log(JSON.stringify(item, null, 2));
          return;
        }
        await printWorkSummary(paths, item);
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
    .option("--stage <stage>", "Stage output to show: current, latest, run, check, fix, or review", parseLogStage, "current")
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
    .command("attach")
    .description("Attach to one materialized repo task's tmux session in a work item.")
    .argument("<id>")
    .requiredOption("--target <target-id>", "Workspace target to attach")
    .option("--stage <stage>", "Attach to a lifecycle stage session such as run, fix, plan, or review")
    .action((id: string, options: { target: string; stage?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const task = selectOneWorkTask(paths, item, options.target);
        const repoPaths = resolvePaths(task.repoPath);
        const meta = getTask(repoPaths, task.taskId);
        const session = resolveAttachSession(repoPaths, meta, options.stage);
        if (!tmuxSessionExists(session)) {
          const status = meta.supervisorPid || meta.childPid ? `status: ${meta.status}, supervisor: ${meta.supervisorPid ?? "-"}` : `status: ${meta.status}`;
          throw new DevtaskError(`No attachable session for ${task.target}/${task.taskId} (${status}).`);
        }
        attachTmuxSession(session);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("steer")
    .description("Send live feedback to one materialized repo task in a work item.")
    .argument("<id>")
    .argument("[message...]")
    .requiredOption("--target <target-id>", "Workspace target to steer")
    .option("-f, --file <path>", "Read feedback from a file")
    .option("-n, --lines <count>", "Capture this many lines after sending", parsePositiveInteger, 20)
    .option("--stage <stage>", "Steer a lifecycle stage session such as run, fix, plan, or review")
    .action((id: string, messageParts: string[], options: { target: string; file?: string; lines: number; stage?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const task = selectOneWorkTask(paths, item, options.target);
        const repoPaths = resolvePaths(task.repoPath);
        steerTask(repoPaths, task.taskId, {
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
          if (startStageSessionIfRequested(repoPaths, unit.taskId, "review", ["task", "review", unit.taskId, "--plain"], options)) {
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
        const blockers = workPrPreflightBlockers(id, preflights, draft);
        if (blockers.length > 0) {
          printPrPreflightBlockers(blockers);
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
            status: workflowCiStatus(meta.status),
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

  work
    .command("cleanup")
    .description("Remove a work item's local metadata and materialized repo task worktrees.")
    .argument("<id>")
    .option("--dry-run", "Print cleanup plan without deleting anything")
    .option("--force", "Clean up even when tasks are running or worktrees are dirty")
    .action(async (id: string, options: { dryRun?: boolean; force?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const item = getWorkItem(paths, id);
        const result = await cleanupWorkItem(paths, item, {
          dryRun: options.dryRun === true,
          force: options.force === true
        });
        for (const plan of result.taskPlans) {
          printCleanupPlan(`${plan.target}/${plan.plan.taskId}`, plan.plan);
        }
        console.log(`${item.id}`);
        for (const action of result.actions) {
          console.log(`  PLAN ${action}`);
        }
        for (const blocker of result.blockers) {
          console.log(`  BLOCKED ${blocker}`);
        }
        if (result.blockers.length > 0 && !options.force) {
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

  registerTaskCommands(program);
  registerJiraCommands(program);

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


  return program;
}
