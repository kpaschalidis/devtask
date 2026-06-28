import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { resolvePaths } from "../infra/paths.js";
import { runCommand } from "../infra/process-runner.js";
import { DevtaskError } from "../infra/errors.js";
import { readWorkMaterialization } from "./work-materialization-service.js";
import type { VerifyCommandResult, VerifyTaskResult, VerifyWorkResult } from "./work-service.js";

export async function runDeterministicChecks(
  paths: DevtaskPaths,
  workId: string,
  repoIds?: readonly string[]
): Promise<VerifyWorkResult> {
  const materialization = requireMaterialization(paths, workId);
  const targetTasks = repoIds?.length
    ? materialization.tasks.filter((task) => repoIds.includes(task.repoId))
    : materialization.tasks;
  const tasks: VerifyTaskResult[] = [];

  for (const task of targetTasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const config = readConfig(repoPaths);
    if (config.verify.length === 0) {
      tasks.push({
        repoId: task.repoId,
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        status: "skipped",
        commands: [],
        error: null
      });
      continue;
    }

    const commandResults: VerifyCommandResult[] = [];
    let taskStatus: VerifyTaskResult["status"] = "passed";
    let taskError: string | null = null;

    for (const command of config.verify) {
      const result = await runCommand("sh", ["-c", command], { cwd: task.worktreePath });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
      const status: VerifyCommandResult["status"] = result.exitCode === 0 ? "passed" : "failed";
      commandResults.push({
        command,
        status,
        exitCode: result.exitCode,
        output
      });
      if (status === "failed") {
        taskStatus = "failed";
        taskError = output || `Command failed with exit code ${result.exitCode ?? "unknown"}`;
        break;
      }
    }

    tasks.push({
      repoId: task.repoId,
      taskId: task.taskId,
      worktreePath: task.worktreePath,
      status: taskStatus,
      commands: commandResults,
      error: taskError
    });
  }

  return {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  };
}

export async function runDeterministicChecksForRepo(paths: DevtaskPaths, workId: string, repoId: string): Promise<VerifyTaskResult> {
  const result = await runDeterministicChecks(paths, workId, [repoId]);
  const task = result.tasks.find((entry) => entry.repoId === repoId);
  if (!task) {
    throw new DevtaskError(`No deterministic check result found for repo ${repoId} in work item ${workId}`);
  }
  return task;
}

function requireMaterialization(paths: DevtaskPaths, workId: string) {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work ${workId} is not materialized. Run devtask work materialize ${workId} first.`);
  }
  return materialization;
}
