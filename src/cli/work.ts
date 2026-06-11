import fs from "node:fs";
import { Command } from "commander";
import { DevtaskError } from "../infra/errors.js";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { getWorkBoard } from "../services/board-service.js";
import {
  checkWork,
  checkWorkCi,
  cleanupWork,
  compoundWork,
  createWorkPullRequests,
  createManualWork,
  getWork,
  importJiraWork,
  listWork,
  materializeWork,
  executeWork,
  planWork,
  readWorkPlanRecord,
  repoPlanWork,
  reviewWork,
  specWork,
  verifyWork
} from "../services/work-service.js";
import { getLatestWorkPhaseRun, hasWorkPhaseRuns, listWorkPhaseRuns } from "../services/phase-run-service.js";
import { getWorkDiagnostics } from "../services/work-diagnostics-service.js";
import { inspectWork } from "../services/work-inspection-service.js";
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
        const rows = listWorkPhaseRuns(resolveWorkspacePaths(), workId, {
          phase: normalizePhaseOption(options.phase),
          repoId: options.repo,
          latest: options.latest === true
        });
        if (rows.length === 0) {
          console.log(hasWorkPhaseRuns(resolveWorkspacePaths(), workId) ? "No matching phase runs" : "No phase runs");
          return;
        }
        printTable(
          ["RUN", "PHASE", "REPO", "TASK", "STATUS", "FINISHED", "SESSION", "SUMMARY"],
          rows.map((row) => [
            row.runId,
            row.phase,
            row.repoId ?? "-",
            row.taskId ?? "-",
            row.status,
            row.finishedAt,
            row.session.transportSessionId ?? "-",
            row.session.summary ?? "-"
          ])
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
        const rows = await getWorkBoard(resolveWorkspacePaths(), workId);
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
            ["PHASE", "REPO", "TASK", "STATUS", "SESSION", "THREAD", "SESSION_FILE", "PROMPT", "ARTIFACTS", "RUN_FILE"],
            inspection.latestPhaseRuns.map((run) => [
              run.phase,
              run.repoId ?? "-",
              run.taskId ?? "-",
              run.status,
              run.transportSessionId ?? "-",
              run.threadId ?? "-",
              run.sessionFilePath ?? "-",
              run.promptPath,
              Object.entries(run.artifacts).map(([name, artifactPath]) => `${name}=${artifactPath}`).join(", ") || "-",
              run.filePath
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
        const specPath = `${paths.workDir}/${workId}/spec.md`;
        if (!fs.existsSync(specPath)) {
          console.log(`Next: devtask work spec ${workId}`);
          return;
        }
        const record = readWorkPlanRecord(resolveWorkspacePaths(), workId);
        if (!record) {
          console.log(`Next: devtask work plan ${workId}`);
          return;
        }
        const repoPlansDir = `${paths.workDir}/${workId}/repo-plans`;
        const hasRepoPlans = fs.existsSync(repoPlansDir) && fs.readdirSync(repoPlansDir).some((entry) => entry.endsWith(".md"));
        console.log(
          record.status === "planned"
            ? hasRepoPlans
              ? `Next: devtask work materialize ${workId}`
              : `Next: devtask work repo-plan ${workId}`
            : `Next: devtask work plan ${workId}`
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("plan")
    .description("Run the global work planner from the refined spec.")
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
    .description("Refine the work source into an implementation-ready spec.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await specWork(resolveWorkspacePaths(), workId, {
          onStart: (start) => {
            console.log(`Prompt: ${start.promptPath}`);
            console.log(`Spec: ${start.specPath}`);
            console.log(`Output: ${start.outputPath}`);
            console.log(`Command: ${start.command}`);
          }
        });
        console.log("");
        console.log(`Spec status: ${result.status}`);
        console.log(`Spec path: ${result.specPath}`);
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("repo-plan")
    .description("Run repo-local implementation planning after the global plan is ready.")
    .argument("<work-id>")
    .option("--refresh", "Rerun repo-local planning even if a repo plan already exists")
    .action(async (workId: string, options: { refresh?: boolean }) => {
      try {
        const result = await repoPlanWork(resolveWorkspacePaths(), workId, {
          refresh: options.refresh === true,
          onRepoPlanStart: (repoId, start) => {
            console.log(`Repo ${repoId} prompt: ${start.promptPath}`);
            console.log(`Repo ${repoId} plan: ${start.planPath}`);
          }
        });
        printTable(
          ["REPO", "TASK", "STATUS", "PLAN", "WORKTREE_CHANGED"],
          result.repoPlans.map((task) => [task.repoId, task.taskId, task.status, task.planPath, String(task.worktreeChanged)])
        );
      } catch (error) {
        printError(error);
      }
    });

  work
    .command("execute")
    .description("Launch or resume repo-task execution sessions for a work item.")
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

  work
    .command("review")
    .description("Run an agent-backed review for each repo task.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const result = await reviewWork(resolveWorkspacePaths(), workId);
        printTable(
          ["REPO", "TASK", "STATUS", "SUMMARY", "CHECK", "VERIFY", "CI"],
          result.tasks.map((task) => [
            task.repoId,
            task.taskId,
            task.status,
            task.summary,
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

function normalizePhaseOption(value: string | undefined): "spec" | "plan" | "repo-plan" | "review" | "execute" | "compound" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "spec" || value === "plan" || value === "repo-plan" || value === "review" || value === "execute" || value === "compound") {
    return value;
  }
  throw new DevtaskError(`Invalid phase ${value}`);
}

function normalizeRequiredPhase(value: string): "spec" | "plan" | "repo-plan" | "review" | "execute" | "compound" {
  return normalizePhaseOption(value) ?? failMissingPhase();
}

function failMissingPhase(): never {
  throw new DevtaskError("Phase is required");
}
