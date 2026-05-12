import { readConfig } from "../config.js";
import { DevtaskError } from "../errors.js";
import { planMarkdownPath, resolvePaths, resolveWorkspacePaths, workItemMaterializationPath } from "../paths.js";
import { hasTaskPlan } from "../planner.js";
import { assertReviewReady } from "../stage-policy.js";
import { buildTaskReview } from "../task-inspection.js";
import { getTask } from "../task-store.js";
import { approveWorkPlan, readWorkMaterialization } from "../work-materializer.js";
import { runWorkPlanner, workGraphPath, workPlanPath } from "../work-planner.js";
import { getWorkSpecState } from "../work-spec-state.js";
import { readWorkStageLedger, runWorkStage } from "../work-stage-contracts.js";
import type { WorkItem } from "../work-store.js";
import { DEFAULT_DEV_WORKFLOW, type WorkflowStageId, workflowStageFailed } from "../workflow-engine.js";
import {
  approveTask,
  checkCiForTask,
  checkTask,
  existingWorkPlanArtifacts,
  followWorkRun,
  openPrForTask,
  printTable,
  printWorkflowStageResult,
  resolvePrDraftMode,
  runReadyWorkTasks,
  runWorkRepoPlans,
  runWorkWorkflowStage,
  reviewTask,
  shellQuote,
  workflowCiStatus
} from "./support.js";

export async function runWorkSpec(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<void> {
  await runWorkStage(paths, item.id, "spec", {
    input: {
      refresh: options.refresh === true
    }
  }, async () => {
    let materialization = readWorkMaterialization(paths, item.id);
    if (!materialization) {
      if (!existingWorkPlanArtifacts(paths, item.id) || options.refresh) {
        await runWorkspacePlanner(paths, item);
      }
      materialization = await materializeWorkPlan(paths, item);
    } else if (options.refresh) {
      throw new DevtaskError(`Work item ${item.id} has already been materialized. Refresh repo plans with devtask work repo-plan ${item.id} --refresh.`);
    }

    const specBeforeRepoPlan = getWorkSpecState(paths, item);
    if (specBeforeRepoPlan.status === "repo-planning") {
      console.log(`Repo planning is still running for ${item.id}.`);
      console.log(`Next: ${specBeforeRepoPlan.next}`);
      const repoPlans = specBeforeRepoPlan.tasks.map((task) => ({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath: task.planPath,
        status: task.status === "planned" ? "existing" : "started"
      }));
      return {
        result: repoPlans,
        final: {
          status: "running",
          output: {
            taskCount: materialization.tasks.length,
            repoPlanCount: repoPlans.length,
            startedCount: repoPlans.filter((result) => result.status === "started").length
          },
          artifacts: [
            workPlanPath(paths, item.id),
            workGraphPath(paths, item.id),
            workItemMaterializationPath(paths, item.id),
            ...repoPlans.map((result) => result.planPath)
          ],
          reason: specBeforeRepoPlan.reason
        }
      };
    }

    const repoPlans = await runRepoPlansForSpec(paths, item, options);
    return {
      result: repoPlans,
      final: {
        status: repoPlanStageStatus(repoPlans),
        output: {
          taskCount: materialization.tasks.length,
          repoPlanCount: repoPlans.length,
          startedCount: repoPlans.filter((result) => result.status === "started").length
        },
        artifacts: [
          workPlanPath(paths, item.id),
          workGraphPath(paths, item.id),
          workItemMaterializationPath(paths, item.id),
          ...repoPlans.map((result) => result.planPath)
        ]
      }
    };
  });
}

async function runWorkspacePlanner(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): Promise<void> {
  const config = readConfig(paths);
  console.log(`Running work planner for ${item.id}`);
  const record = await runWorkStage(paths, item.id, "plan", {
    input: {
      sourceType: item.source.type,
      sourceArtifact: item.source.artifact
    }
  }, async () => {
    const planRecord = await runWorkPlanner(paths, item, config, {
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
    return {
      result: planRecord,
      final: {
        status: planRecord.status === "planned" ? "passed" : "failed",
        output: {
          planId: planRecord.planId,
          exitCode: planRecord.exitCode,
          planPath: planRecord.planPath,
          graphPath: planRecord.graphPath,
          outputPath: planRecord.outputPath
        },
        artifacts: [planRecord.promptPath, planRecord.outputPath, planRecord.planPath, planRecord.graphPath],
        reason: planRecord.status === "failed" ? "planner exited without producing valid plan artifacts" : null
      }
    };
  });
  console.log(`Plan: ${record.status}`);
  console.log(`File: ${record.planPath}`);
  console.log(`Graph: ${record.graphPath}`);
  if (record.status === "failed") {
    throw new DevtaskError(`Work planner failed for ${item.id}`);
  }
}

async function materializeWorkPlan(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): Promise<NonNullable<ReturnType<typeof readWorkMaterialization>>> {
  console.log(`Materializing work plan ${item.id}`);
  const materialization = await runWorkStage(paths, item.id, "approve-plan", {
    input: {
      planPath: workPlanPath(paths, item.id),
      graphPath: workGraphPath(paths, item.id)
    }
  }, async () => {
    const result = await approveWorkPlan(paths, item);
    return {
      result,
      final: {
        status: "passed",
        output: {
          taskCount: result.tasks.length,
          materializedAt: result.materializedAt
        },
        artifacts: [result.approvedGraphPath, workItemMaterializationPath(paths, item.id)]
      }
    };
  });
  console.log(`Materialized ${materialization.tasks.length} task(s)`);
  return materialization;
}

async function runRepoPlansForSpec(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<Awaited<ReturnType<typeof runWorkRepoPlans>>> {
  console.log(`Running repo plans for ${item.id}`);
  const results = await runWorkStage(paths, item.id, "repo-plan", {
    input: {
      refresh: options.refresh === true
    }
  }, async () => {
    const repoPlanResults = await runWorkRepoPlans(paths, item, options);
    return {
      result: repoPlanResults,
      final: {
        status: repoPlanStageStatus(repoPlanResults),
        output: {
          taskCount: repoPlanResults.length,
          startedCount: repoPlanResults.filter((result) => result.status === "started").length
        },
        artifacts: repoPlanResults.map((result) => result.planPath)
      }
    };
  });
  printTable(
    ["TARGET", "TASK", "STATUS", "PLAN"],
    results.map((result) => [result.target, result.taskId, result.status, result.planPath])
  );
  if (results.some((result) => !["planned", "existing"].includes(result.status))) {
    console.log("");
    console.log(`Repo planning is still running for ${item.id}.`);
    console.log(`Next: devtask work board ${item.id}`);
  }
  return results;
}

function repoPlanStageStatus(results: Awaited<ReturnType<typeof runWorkRepoPlans>>): "passed" | "running" | "failed" {
  if (results.some((result) => result.status === "started")) {
    return "running";
  }
  return results.every((result) => ["planned", "existing"].includes(result.status)) ? "passed" : "failed";
}

export function assertRepoPlansReady(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): Array<{ target: string; taskId: string; planPath: string }> {
  const spec = getWorkSpecState(paths, item);
  if (spec.status !== "ready") {
    throw new DevtaskError(`Work spec ${item.id} is not ready for approval: ${spec.reason ?? spec.status}. Next: ${spec.next}`);
  }
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    throw new DevtaskError(`Work item ${item.id} has not been materialized. Run devtask work spec ${item.id} first.`);
  }
  return materialization.tasks.map((task) => {
    const repoPaths = resolvePaths(task.repoPath);
    if (!hasTaskPlan(repoPaths, task.taskId)) {
      throw new DevtaskError(`${task.target}/${task.taskId} is missing a repo plan. Run devtask work spec ${item.id}.`);
    }
    return {
      target: task.target,
      taskId: task.taskId,
      planPath: planMarkdownPath(repoPaths, task.taskId)
    };
  });
}

export async function runWorkExec(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { auto?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean; poll: number }
): Promise<void> {
  assertSpecApproved(paths, item);
  await runWorkStage(paths, item.id, "exec", {
    input: {
      auto: options.auto === true
    }
  }, async () => {
    if (!options.auto) {
      await runReadyWorkTasks(paths, item, options);
      return {
        result: undefined,
        final: {
          status: "running",
          output: {
            mode: "manual"
          }
        }
      };
    }

    await followWorkRun(paths, item, options);
    const checkResult = await runWorkWorkflowStage(paths, item, "check", undefined, async (unit) => {
      const repoPaths = resolvePaths(unit.repoPath);
      const verification = await checkTask(repoPaths, unit.taskId, { exitOnFailure: false, verbose: false });
      return {
        status: verification.status === "failed" ? "failed" : "passed",
        detail: verification.status
      };
    });
    printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], checkResult);
    if (workflowStageFailed(checkResult)) {
      return {
        result: checkResult,
        final: {
          status: "failed",
          output: {
            failedStage: "check"
          },
          reason: `checks failed; run devtask work fix ${item.id}`
        }
      };
    }

    const reviewResult = await runWorkWorkflowStage(paths, item, "review", undefined, async (unit) => {
      const repoPaths = resolvePaths(unit.repoPath);
      assertReviewReady(repoPaths, getTask(repoPaths, unit.taskId), readConfig(repoPaths));
      await reviewTask(repoPaths, unit.taskId, { exitOnFindings: false });
      const latest = await buildTaskReview(repoPaths, getTask(repoPaths, unit.taskId));
      return {
        status: latest.latestReviewAgent?.status === "passed" ? "passed" : "failed",
        detail: latest.latestReviewAgent?.status ?? "missing"
      };
    });
    printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], reviewResult);
    return {
      result: reviewResult,
      final: {
        status: workflowStageFailed(reviewResult) ? "failed" : "passed",
        output: {
          next: `devtask work approve-exec ${item.id}`
        },
        reason: workflowStageFailed(reviewResult) ? `review failed; run devtask work fix ${item.id} --from review` : null
      }
    };
  });
  const execStage = readWorkStageLedger(paths, item.id).stages.exec;
  if (execStage?.status === "failed") {
    throw new DevtaskError(execStage.reason ?? `Work execution failed for ${item.id}`);
  }
  console.log("");
  console.log(`Next: ${workNextCommand(paths, item)}`);
}

export async function runWorkApproveExec(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { force?: boolean; draft?: boolean; ready?: boolean }
): Promise<{
  approval: Awaited<ReturnType<typeof runWorkWorkflowStage>>;
  pr: Awaited<ReturnType<typeof runWorkWorkflowStage>>;
  ci: Awaited<ReturnType<typeof runWorkWorkflowStage>>;
}> {
  const prOptions = {
    ...options,
    ready: options.draft ? false : true
  };
  const result = await runWorkStage(paths, item.id, "approve-exec", {
    input: {
      force: options.force === true,
      draft: resolvePrDraftMode(prOptions)
    }
  }, async () => {
    const approval = await runWorkWorkflowStage(paths, item, "approve", undefined, async (unit) => {
      const detail = await approveTask(resolvePaths(unit.repoPath), unit.taskId, { force: options.force === true });
      return { status: "passed", detail };
    });
    if (workflowStageFailed(approval)) {
      return {
        result: {
          approval,
          pr: emptyWorkflowResult("pr"),
          ci: emptyWorkflowResult("ci")
        },
        final: {
          status: "failed",
          output: {
            failedStage: "approve"
          },
          reason: "implementation approval failed"
        }
      };
    }

    const pr = await runWorkWorkflowStage(paths, item, "pr", undefined, async (unit) => {
      const repoPaths = resolvePaths(unit.repoPath);
      const meta = getTask(repoPaths, unit.taskId);
      if (meta.status === "pr-open" && meta.prUrl) {
        return { status: "skipped", detail: meta.prUrl };
      }
      const prUrl = await openPrForTask(repoPaths, unit.taskId, prOptions);
      return { status: "passed", detail: prUrl };
    });
    if (workflowStageFailed(pr)) {
      return {
        result: {
          approval,
          pr,
          ci: emptyWorkflowResult("ci")
        },
        final: {
          status: "failed",
          output: {
            failedStage: "pr"
          },
          reason: "PR creation failed"
        }
      };
    }

    const ci = await runWorkWorkflowStage(paths, item, "ci", undefined, async (unit) => {
      const repoPaths = resolvePaths(unit.repoPath);
      await checkCiForTask(repoPaths, unit.taskId);
      const meta = getTask(repoPaths, unit.taskId);
      return {
        status: workflowCiStatus(meta.status),
        detail: meta.status
      };
    });
    return {
      result: {
        approval,
        pr,
        ci
      },
      final: {
        status: workflowStageFailed(ci) ? "failed" : "passed",
        output: {
          prCount: pr.results.length,
          ciStatus: workflowStageFailed(ci) ? "failed" : "passed"
        },
        reason: workflowStageFailed(ci) ? "CI check failed" : null
      }
    };
  });
  return result;
}

function assertSpecApproved(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): void {
  const stage = readWorkStageLedger(paths, item.id).stages["approve-spec"];
  if (stage?.status !== "passed") {
    throw new DevtaskError(`Work spec ${item.id} is not approved. Run devtask work approve-spec ${item.id} first.`);
  }
}

export function workNextCommand(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): string {
  const spec = getWorkSpecState(paths, item);
  if (spec.status !== "ready") {
    return spec.next;
  }
  const ledger = readWorkStageLedger(paths, item.id);
  if (ledger.stages["approve-spec"]?.status !== "passed") {
    return spec.next;
  }
  if (ledger.stages.exec?.status !== "passed") {
    return `devtask work exec ${shellQuote(item.id)} --auto`;
  }
  if (ledger.stages["approve-exec"]?.status !== "passed") {
    return `devtask work approve-exec ${shellQuote(item.id)}`;
  }
  return `devtask work board ${shellQuote(item.id)}`;
}

function emptyWorkflowResult(stage: WorkflowStageId): Awaited<ReturnType<typeof runWorkWorkflowStage>> {
  return {
    workflowId: DEFAULT_DEV_WORKFLOW.id,
    stage,
    results: []
  };
}
