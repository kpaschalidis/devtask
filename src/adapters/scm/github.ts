import { DevtaskError } from "../../infra/errors.js";
import { runCommand, runCommandOrThrow } from "../../infra/process-runner.js";
import type { CiCheckResult, PullRequestComment, PullRequestOptions, PullRequestSummary } from "./shared.js";
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
  return {
    provider: "github",
    status: result.exitCode === 0 ? "passed" : "failed",
    detail: output || `gh pr checks exited ${result.exitCode}`,
    url: prUrl
  };
}

export async function listGitHubPullRequests(worktreePath: string): Promise<PullRequestSummary[]> {
  const result = await runCommandOrThrow("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,headRefName,url"
  ], { cwd: worktreePath });
  return parseGitHubPullRequests(JSON.parse(result.stdout) as unknown);
}

export async function listGitHubPullRequestComments(
  worktreePath: string,
  pullRequestId: string
): Promise<PullRequestComment[]> {
  const result = await runCommandOrThrow("gh", [
    "pr",
    "view",
    pullRequestId,
    "--json",
    "comments"
  ], { cwd: worktreePath });
  return parseGitHubPullRequestComments(JSON.parse(result.stdout) as unknown);
}

function parseGitHubPullRequests(value: unknown): PullRequestSummary[] {
  if (!Array.isArray(value)) {
    throw new DevtaskError("GitHub pull request list response was not an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new DevtaskError("GitHub pull request entry was not an object");
    }
    return {
      id: requireString(entry, "number"),
      number: requireString(entry, "number"),
      title: requireString(entry, "title"),
      branch: requireString(entry, "headRefName"),
      url: readOptionalString(entry, "url")
    };
  });
}

function parseGitHubPullRequestComments(value: unknown): PullRequestComment[] {
  if (!isRecord(value) || !Array.isArray(value.comments)) {
    throw new DevtaskError("GitHub pull request comments response was not an object with comments");
  }
  return value.comments.map((entry) => {
    if (!isRecord(entry)) {
      throw new DevtaskError("GitHub pull request comment entry was not an object");
    }
    const author = isRecord(entry.author) ? readOptionalString(entry.author, "login") : null;
    return {
      id: requireString(entry, "id"),
      body: requireString(entry, "body"),
      author,
      createdAt: readOptionalString(entry, "createdAt"),
      url: readOptionalString(entry, "url")
    };
  });
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new DevtaskError(`GitHub response field ${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
