import fs from "node:fs";
import { DevtaskError } from "./infra/errors.js";
import { taskDir, taskMetaPath, type DevtaskPaths } from "./infra/paths.js";
import { readTaskMeta } from "./storage/meta.js";
import { runCommand, runCommandOrThrow } from "./infra/process-runner.js";

export interface CleanupOptions {
  dryRun?: boolean;
  force?: boolean;
  keepWorktree?: boolean;
  keepMetadata?: boolean;
}

export interface CleanupPlan {
  taskId: string;
  worktreePath: string;
  metadataPath: string;
  actions: string[];
  blockers: string[];
}

export async function planTaskCleanup(paths: DevtaskPaths, id: string, options: CleanupOptions = {}): Promise<CleanupPlan> {
  const meta = readTaskMeta(taskMetaPath(paths, id));
  const blockers: string[] = [];
  const actions: string[] = [];

  if (meta.status === "running") {
    blockers.push("task is running");
  }

  if (!options.keepWorktree && fs.existsSync(meta.worktreePath)) {
    const dirty = await isWorktreeDirty(meta.worktreePath);
    if (dirty) {
      blockers.push("worktree has uncommitted changes");
    }
    actions.push(`remove worktree ${meta.worktreePath}`);
  }

  if (!options.keepMetadata && fs.existsSync(taskDir(paths, id))) {
    actions.push(`remove metadata ${taskDir(paths, id)}`);
  }

  if (actions.length === 0) {
    actions.push("nothing to remove");
  }

  return {
    taskId: id,
    worktreePath: meta.worktreePath,
    metadataPath: taskDir(paths, id),
    actions,
    blockers
  };
}

export async function cleanupTask(paths: DevtaskPaths, id: string, options: CleanupOptions = {}): Promise<CleanupPlan> {
  const plan = await planTaskCleanup(paths, id, options);
  if (plan.blockers.length > 0 && !options.force) {
    throw new DevtaskError(`Cleanup refused for ${id}: ${plan.blockers.join("; ")}. Use --force to override.`);
  }

  if (options.dryRun) {
    return plan;
  }

  if (!options.keepWorktree && fs.existsSync(plan.worktreePath)) {
    await removeWorktree(paths.root, plan.worktreePath, options.force === true);
  }

  if (!options.keepMetadata && fs.existsSync(plan.metadataPath)) {
    fs.rmSync(plan.metadataPath, { recursive: true, force: true });
  }

  return plan;
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const result = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
  return result.stdout.trim().length > 0;
}

async function removeWorktree(root: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) {
    args.push("--force");
  }
  args.push(worktreePath);
  await runCommandOrThrow("git", args, { cwd: root });
}
