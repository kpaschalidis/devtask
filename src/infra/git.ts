import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import { runCommand, runCommandOrThrow } from "./process-runner.js";
import { copySkillsToDir } from "../skills/loader.js";

export async function assertGitHasHead(root: string): Promise<void> {
  try {
    await runCommandOrThrow("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
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
    await runCommandOrThrow("git", ["worktree", "add", "-b", branch, targetPath, "HEAD"], { cwd: root });
    await excludeDevtaskRuntimeFiles(targetPath);
    await installWorktreeDependencies(targetPath);
    copySkillsToDir(targetPath, ["commit", "review"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DevtaskError(`Failed to create worktree for branch ${branch}: ${detail}`);
  }
}

async function installWorktreeDependencies(worktreePath: string): Promise<void> {
  if (!fs.existsSync(path.join(worktreePath, "package.json"))) return;
  const hasYarnLock = fs.existsSync(path.join(worktreePath, "yarn.lock"));
  const hasPnpmLock = fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"));
  const [cmd, args]: [string, string[]] = hasYarnLock
    ? ["yarn", ["install", "--prefer-offline"]]
    : hasPnpmLock
      ? ["pnpm", ["install", "--prefer-offline"]]
      : ["npm", ["install", "--prefer-offline"]];
  await runCommand(cmd, args, { cwd: worktreePath });
}

export async function excludeDevtaskRuntimeFiles(worktreePath: string): Promise<void> {
  const result = await runCommandOrThrow("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktreePath });
  const excludePath = path.resolve(worktreePath, result.stdout.trim());
  const entries = [".devtask_state.md", ".devtask_result.json", ".claude/", ".codex/"];
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const missing = entries.filter((entry) => !existing.split("\n").includes(entry));

  if (missing.length === 0) {
    return;
  }

  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludePath, `${prefix}${missing.join("\n")}\n`);
}
