import fs from "node:fs";
import { execa } from "execa";
import { DevtaskError } from "./errors.js";

export async function assertGitHasHead(root: string): Promise<void> {
  try {
    await execa("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
  } catch {
    throw new DevtaskError("Cannot create task worktrees before the repository has an initial commit.");
  }
}

export async function createTaskWorktree(root: string, branch: string, targetPath: string): Promise<void> {
  if (fs.existsSync(targetPath)) {
    return;
  }

  await assertGitHasHead(root);

  try {
    await execa("git", ["worktree", "add", "-b", branch, targetPath, "HEAD"], { cwd: root });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DevtaskError(`Failed to create worktree for branch ${branch}: ${detail}`);
  }
}
