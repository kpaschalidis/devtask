import { DevtaskError } from "../../infra/errors.js";
import { runCommand, runCommandOrThrow } from "../../infra/process-runner.js";
import type { CiCheckResult, PullRequestOptions } from "./shared.js";
import { pushBranch } from "./shared.js";

export async function createGitHubPullRequest(worktreePath: string, options: PullRequestOptions): Promise<string> {
  await runCommandOrThrow("gh", ["--version"], { cwd: worktreePath });
  await pushBranch(worktreePath, options.branch);

  const args = ["pr", "create", "--title", options.title, "--body", options.body];
  if (options.draft) {
    args.push("--draft");
  }

  const result = await runCommandOrThrow("gh", args, { cwd: worktreePath });
  const prUrl = result.stdout.trim().split("\n").at(-1);
  if (!prUrl) {
    throw new DevtaskError("gh did not return a PR URL");
  }
  return prUrl;
}

export async function checkGitHubCi(worktreePath: string, prUrl: string): Promise<CiCheckResult> {
  const result = await runCommand("gh", ["pr", "checks", prUrl], { cwd: worktreePath });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const status: CiCheckResult["status"] = result.exitCode === 0 ? "passed" : "failed";
  return {
    provider: "github",
    status,
    detail: output || `gh pr checks exited ${result.exitCode}`,
    url: prUrl,
    failureOutput: status === "failed" ? output || `gh pr checks exited ${result.exitCode}` : null
  };
}
