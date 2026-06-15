import fs from "node:fs";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { DevtaskError } from "../infra/errors.js";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { buildWorkBoard } from "../board/work-board.js";
import {
  checkWork,
  checkWorkCi,
  cleanupWork,
  compoundWork,
  createWorkPullRequests,
  createManualWork,
  freshExecuteWork,
  getWork,
  importJiraWork,
  listWork,
  materializeWork,
  executeWork,
  runManagedPhaseHookFinalizer,
  sendWorkPhaseFeedback,
  attachWorkPhase,
  startOrchestrateWork,
  runRepoPlanWorker,
  startReviewWork,
  startReviewScope,
  getWorkMaterializationState,
  verifyWork,
  approveWorkGate,
  runValidateWorker,
  resetTaskForFix
} from "../services/work-service.js";
import { killLiveSession } from "../roles/runner.js";
import type { GateName } from "../mission/gates.js";
import { watchAndAutoApprove } from "../mission/auto-approve.js";
import { getLatestWorkPhaseRun, hasWorkPhaseRuns, listWorkPhaseRuns, listWorkPhaseSessions } from "../services/session-run-service.js";
import { getWorkDiagnostics } from "../services/work-diagnostics-service.js";
import { inspectWork } from "../services/work-inspection-service.js";
import { recommendWorkNextAction } from "../board/next-actions.js";
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

  const runs = work.command("runs").description("Inspect persisted phase runs for one work item.");

  runs
    .argument("<work-id>")
    .option("--phase <phase>", "Filter to one phase")
    .option("--repo <repo-id>", "Filter to one repo task scope")
    .option("--latest", "Show the latest run per phase/repo scope")
    .action((workId: string, options: { phase?: string; repo?: string; latest?: boolean }) => {
      try {
        const phase = normalizePhaseOption(options.phase);
        const paths = resolveWorkspacePaths();
        const rows = listWorkPhaseRuns(paths, workId, {
          phase,
          repoId: options.repo,
          latest: options.latest === true
        });
        const liveSessions = listWorkPhaseSessions(paths, workId)
          .filter((session) => phase ? session.phase === phase : true)
          .filter((session) => options.repo ? session.repoId === options.repo : true);
        if (rows.length === 0 && liveSessions.length === 0) {
          console.log(hasWorkPhaseRuns(paths, workId) ? "No matching phase runs" : "No phase runs");
          return;
        }
        printTable(
          ["RUN", "PHASE", "REPO", "TASK", "STATUS", "FINISHED", "SESSION", "SUMMARY"],
          [
            ...liveSessions.map((session) => [
              session.runId,
              session.phase,
              session.repoId ?? "-",
              session.taskId ?? "-",
              session.live ? "running" : session.status,
              session.live ? "-" : session.updatedAt,
              session.tmuxSession,
              session.session.summary ?? "-"
            ]),
            ...rows.map((row) => [
              row.runId,
              row.phase,
              row.repoId ?? "-",
              row.taskId ?? "-",
              row.status,
              row.finishedAt,
              row.session.transportId ?? "-",
              row.session.summary ?? "-"
            ])
          ]
        );
      } catch (error) {
        printError(error);
      }
    });

  runs
    .command("show")
    .description("Show the latest persisted phase run for one work item scope.")
    .argument("<work-id>")
    .argument("<phase>")
    .argument("[repo-id]")
    .action((workId: string, phase: string, repoId?: string) => {
      try {
        const run = getLatestWorkPhaseRun(resolveWorkspacePaths(), workId, normalizeRequiredPhase(phase), repoId);
        if (!run) {
          console.log("No phase run");
          return;
        }
        console.log(JSON.stringify(run, null, 2));
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
        const rows = await buildWorkBoard(resolveWorkspacePaths(), workId);
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

  work
    .command("diagnose")
    .description("Explain what one work item is waiting on and why.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        const diagnostic = getWorkDiagnostics(resolveWorkspacePaths(), workId);
        console.log(`Work: ${diagnostic.workId}`);
        console.log(`Status: ${diagnostic.status}`);
        console.log(`Waiting on: ${diagnostic.waitingOn}`);
        console.log(`Next: ${diagnostic.next}`);
        console.log(`Why: ${diagnostic.reason}`);
        if (diagnostic.missingArtifacts.length > 0) {
          console.log("");
          console.log("Missing artifacts:");
          for (const artifact of diagnostic.missingArtifacts) {
            console.log(`- ${artifact}`);
          }
        }
        if (diagnostic.tasks.length > 0) {
          console.log("");
          printTable(
            ["REPO", "TASK", "STATUS", "WAITING_ON", "NEXT", "WHY"],
            diagnostic.tasks.map((task) => [task.repoId, task.taskId, task.status, task.waitingOn, task.next, task.reason])
          );
        }
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("inspect")
    .description("Inspect stored artifacts, latest runs, and paused/failed/blocked repo tasks for one work item.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        const inspection = inspectWork(resolveWorkspacePaths(), workId);
        console.log(`Work: ${inspection.workId}`);
        console.log(`Status: ${inspection.status}`);
        console.log("");
        printTable(
          ["ARTIFACT", "EXISTS", "PATH"],
          inspection.artifacts.map((artifact) => [artifact.label, String(artifact.exists), artifact.path])
        );
        if (inspection.latestPhaseRuns.length > 0) {
          console.log("");
          printTable(
            ["PHASE", "REPO", "TASK", "STATUS", "PROVIDER", "TRANSPORT", "CONVERSATION", "TRANSCRIPT", "PROMPT", "ARTIFACTS", "RUN_FILE"],
            inspection.latestPhaseRuns.map((run) => [
              run.phase,
              run.repoId ?? "-",
              run.taskId ?? "-",
              run.status,
              run.provider ?? "-",
              run.transportId ?? "-",
              run.conversationId ?? "-",
              run.transcriptPath ?? "-",
              run.promptPath,
              Object.entries(run.artifacts).map(([name, artifactPath]) => `${name}=${artifactPath}`).join(", ") || "-",
              run.filePath
            ])
          );
        }
        if (inspection.livePhaseSessions.length > 0) {
          console.log("");
          printTable(
            ["LIVE_PHASE", "REPO", "TASK", "STATUS", "SESSION", "PROMPT", "OUTPUT"],
            inspection.livePhaseSessions.map((session) => [
              session.phase,
              session.repoId ?? "-",
              session.taskId ?? "-",
              session.live ? "running" : session.status,
              session.tmuxSession,
              session.promptPath,
              session.outputPath
            ])
          );
        }
        if (inspection.problemTasks.length > 0) {
          console.log("");
          printTable(
            ["REPO", "TASK", "STATUS", "REASON", "SESSION", "WORKTREE"],
            inspection.problemTasks.map((task) => [
              task.repoId,
              task.taskId,
              task.status,
              task.reason ?? "-",
              task.sessionName ?? "-",
              task.worktreePath
            ])
          );
        }
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
        const paths = resolveWorkspacePaths();
        const item = getWork(paths, workId);
        const materialization = getWorkMaterializationState(paths, workId);
        const workDir = `${paths.workDir}/${workId}`;
        const repoPlansDir = `${workDir}/repo-plans`;
        const hasOrchestratedPlan =
          fs.existsSync(`${workDir}/plan.md`) &&
          fs.existsSync(`${workDir}/graph.json`) &&
          fs.existsSync(repoPlansDir) &&
          fs.readdirSync(repoPlansDir).some((e) => e.endsWith(".md"));
        console.log(`Next: ${recommendWorkNextAction(item, {
          hasOrchestratedPlan,
          isMaterialized: materialization !== null,
          hasActiveSession: false
        })}`);
      } catch (error) {
        printError(error);
      }
    });

  const orchestrate = work
    .command("orchestrate")
    .description("Start the orchestrator in a background tmux session to produce spec, plan, and repo plans.");
  orchestrate
    .argument("<work-id>")
    .option("--auto", "Automatically approve all gates without human confirmation")
    .action(async (workId: string, options: { auto?: boolean }) => {
      try {
        const paths = resolveWorkspacePaths();
        const result = await startOrchestrateWork(paths, workId);
        console.log(`Started orchestrate session: ${result.tmuxSession}`);
        console.log(`Prompt: ${result.promptPath}`);
        console.log(`Output: ${result.outputPath}`);
        if (options.auto) {
          const initialOffset = fs.existsSync(result.outputPath) ? fs.statSync(result.outputPath).size : 0;
          const child = spawn(
            process.execPath,
            [process.argv[1], "work", "_auto-approve-worker", "--work-id", workId, "--offset", String(initialOffset)],
            { detached: true, stdio: "ignore" }
          );
          child.unref();
          console.log("Auto-approve watcher started in background.");
        }
        console.log(`Attach: devtask work orchestrate attach ${workId}`);
      } catch (error) {
        printError(error);
      }
    });
  orchestrate.command("attach").argument("<work-id>").action(async (workId: string) => {
    try {
      await attachWorkPhase(resolveWorkspacePaths(), "orchestrate", workId);
    } catch (error) {
      printError(error);
    }
  });
  orchestrate.command("feedback").argument("<work-id>").argument("<message...>").action(async (workId: string, messageParts: string[]) => {
    try {
      const result = await sendWorkPhaseFeedback(resolveWorkspacePaths(), "orchestrate", workId, messageParts.join(" "));
      console.log(`Started orchestrate feedback session: ${result.tmuxSession}`);
    } catch (error) {
      printError(error);
    }
  });

  work.command("_repo-plan-worker", { hidden: true })
    .requiredOption("--work-id <id>")
    .requiredOption("--repo-id <id>")
    .action(async (options: { workId: string; repoId: string }) => {
      try {
        await runRepoPlanWorker(resolveWorkspacePaths(), options.workId, options.repoId);
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });

  work.command("_validate-worker", { hidden: true })
    .requiredOption("--work-id <id>")
    .requiredOption("--feature-id <id>")
    .action(async (options: { workId: string; featureId: string }) => {
      try {
        await runValidateWorker(resolveWorkspacePaths(), options.workId, options.featureId);
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });

  work.command("_auto-approve-worker", { hidden: true })
    .requiredOption("--work-id <id>")
    .option("--offset <n>", "Byte offset into the output file to start scanning from", "0")
    .option("--message <msg>", "Approval message to send")
    .action(async (options: { workId: string; offset: string; message?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        await watchAndAutoApprove(paths, options.workId, {
          initialOutputOffset: parseInt(options.offset, 10),
          message: options.message,
          onApprove: (gate) => console.log(`Auto-approved ${gate} for ${options.workId}.`),
          onComplete: () => console.log(`Orchestrator session for ${options.workId} completed.`)
        });
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });

  work.command("_execute-fix", { hidden: true })
    .requiredOption("--work-id <id>")
    .requiredOption("--repo-id <id>")
    .action(async (options: { workId: string; repoId: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        resetTaskForFix(paths, options.workId, options.repoId);
        await executeWork(paths, options.workId);
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });

  work
    .command("approve")
    .description("Approve the current gate in a running orchestrator session.")
    .argument("<work-id>")
    .option("--gate <gate>", "Gate to approve: gate-1 or gate-2", "gate-1")
    .option("--message <msg>", "Approval message sent to the orchestrator")
    .action(async (workId: string, options: { gate: string; message?: string }) => {
      const gate = options.gate as GateName;
      if (gate !== "gate-1" && gate !== "gate-2") {
        console.error(`Invalid gate: ${gate}. Must be gate-1 or gate-2.`);
        process.exit(1);
      }
      try {
        await approveWorkGate(resolveWorkspacePaths(), workId, gate, options.message);
        console.log(`Approved ${gate} for work item ${workId}.`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("stop")
    .description("Kill the running orchestrator session for a work item.")
    .argument("<work-id>")
    .action((workId: string) => {
      try {
        killLiveSession(resolveWorkspacePaths(), workId, "orchestrate", null);
        console.log(`Stopped orchestrator session for work item ${workId}.`);
      } catch (error) {
        printError(error);
      }
    });

  const execute = work
    .command("execute")
    .description("Launch or resume repo-task execution sessions for a work item.");
  execute
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await executeWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "STATUS", "ACTION", "SESSION", "SUMMARY"],
          result.tasks.map((task) => [
            task.repoId,
            task.taskId,
            task.status,
            task.action,
            task.sessionName ?? "-",
            task.summary ?? "-"
          ])
        );
      } catch (error) {
        printError(error);
      }
    });
  execute.command("attach").argument("<work-id>").argument("<repo-id>").action(async (workId: string, repoId: string) => {
    try {
      await attachWorkPhase(resolveWorkspacePaths(), "execute", workId, repoId);
    } catch (error) {
      printError(error);
    }
  });
  execute.command("feedback").argument("<work-id>").argument("<repo-id>").argument("<message...>").action((workId: string, repoId: string, messageParts: string[]) => {
    try {
      const result = sendWorkPhaseFeedback(resolveWorkspacePaths(), "execute", workId, repoId, messageParts.join(" "));
      console.log(result.confirmed ? "Feedback sent" : "Feedback sent; no session change observed yet");
    } catch (error) {
      printError(error);
    }
  });
  execute.command("fresh").argument("<work-id>").argument("<repo-id>").action(async (workId: string, repoId: string) => {
    try {
      freshExecuteWork(resolveWorkspacePaths(), workId, repoId);
      const result = await executeWork(resolveWorkspacePaths(), workId);
      printTable(
        ["REPO", "TASK", "STATUS", "ACTION", "SESSION", "SUMMARY"],
        result.tasks.filter((task) => task.repoId === repoId).map((task) => [
          task.repoId,
          task.taskId,
          task.status,
          task.action,
          task.sessionName ?? "-",
          task.summary ?? "-"
        ])
      );
    } catch (error) {
      printError(error);
    }
  });

  work
    .command("compound")
    .description("Capture reusable learnings and workspace guidance from a completed work item.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await compoundWork(resolveWorkspacePaths(), workId);
        console.log(`Compound status: ${result.status}`);
        console.log(`Planning guidance: ${result.sharedPlanningPath}`);
        console.log(`Implementation guidance: ${result.sharedImplementationPath}`);
        console.log(`Review guidance: ${result.sharedReviewPath}`);
        console.log(`Patterns: ${result.sharedPatternsPath}`);
        console.log(`Local notes: ${result.localNotesPath}`);
      } catch (error) {
        printError(error);
      }
    });

  const review = work
    .command("review")
    .description("Start agent-backed review sessions for each repo task.");
  review
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const launches = await startReviewWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "SESSION", "PROMPT"],
          launches.map((entry) => [entry.repoId ?? "-", entry.taskId ?? "-", entry.tmuxSession, entry.promptPath])
        );
      } catch (error) {
        printError(error);
      }
    });
  review.command("attach").argument("<work-id>").argument("<repo-id>").action(async (workId: string, repoId: string) => {
    try {
      await attachWorkPhase(resolveWorkspacePaths(), "review", workId, repoId);
    } catch (error) {
      printError(error);
    }
  });
  review.command("feedback").argument("<work-id>").argument("<repo-id>").argument("<message...>").action(async (workId: string, repoId: string, messageParts: string[]) => {
    try {
      const result = await sendWorkPhaseFeedback(resolveWorkspacePaths(), "review", workId, repoId, messageParts.join(" "));
      console.log(`Started review feedback session: ${result.tmuxSession}`);
    } catch (error) {
      printError(error);
    }
  });
  review.command("fresh").argument("<work-id>").argument("<repo-id>").action(async (workId: string, repoId: string) => {
    try {
      const launch = await startReviewScope(resolveWorkspacePaths(), workId, repoId);
      console.log(`Started fresh review session: ${launch.tmuxSession}`);
    } catch (error) {
      printError(error);
    }
  });

  work.command("_phase-finalize-hook", { hidden: true }).argument("<phase>").argument("<work-id>").argument("<run-id>").argument("[repo-id]").action(async (phase: string, workId: string, runId: string, repoId?: string) => {
    try {
      const normalized = normalizeRequiredPhase(phase);
      if (normalized !== "orchestrate" && normalized !== "review") {
        throw new DevtaskError(`Unsupported interactive phase finalizer: ${phase}`);
      }
      await runManagedPhaseHookFinalizer(
        resolveWorkspacePaths(process.env.DEVTASK_WORKSPACE_ROOT ?? process.cwd()),
        normalized,
        workId,
        runId,
        repoId ?? null
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
    .command("materialize")
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

function normalizePhaseOption(value: string | undefined): "orchestrate" | "repo-plan" | "review" | "execute" | "compound" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "orchestrate" || value === "repo-plan" || value === "review" || value === "execute" || value === "compound") {
    return value;
  }
  throw new DevtaskError(`Invalid phase ${value}`);
}

function normalizeRequiredPhase(value: string): "orchestrate" | "repo-plan" | "review" | "execute" | "compound" {
  return normalizePhaseOption(value) ?? failMissingPhase();
}

function failMissingPhase(): never {
  throw new DevtaskError("Phase is required");
}
