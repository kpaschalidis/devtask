import { Buffer } from "node:buffer";
import { DevtaskError } from "./errors.js";
import { runCommand, runCommandOrThrow } from "./process-runner.js";

export type ScmProvider = "github" | "bitbucket" | "gitlab";

export interface PullRequestOptions {
  title: string;
  body: string;
  draft: boolean;
  branch: string;
}

export interface RemoteInfo {
  provider: ScmProvider;
  owner: string;
  repo: string;
  remoteUrl: string;
}

export async function createProviderPullRequest(worktreePath: string, options: PullRequestOptions): Promise<string> {
  const remote = await detectRemoteInfo(worktreePath);

  switch (remote.provider) {
    case "github":
      return createGitHubPullRequest(worktreePath, options);
    case "bitbucket":
      return createBitbucketPullRequest(worktreePath, remote, options);
    case "gitlab":
      return createGitLabMergeRequest(worktreePath, options);
  }
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const result = await runCommandOrThrow("git", ["status", "--porcelain"], { cwd: worktreePath });
  return result.stdout.trim().length > 0;
}

export async function countBranchCommits(worktreePath: string): Promise<number> {
  const baseRef = await findPublishBaseRef(worktreePath);
  const mergeBase = await runCommandOrThrow("git", ["merge-base", "HEAD", baseRef], { cwd: worktreePath });
  const result = await runCommandOrThrow("git", ["rev-list", "--count", `${mergeBase.stdout.trim()}..HEAD`], {
    cwd: worktreePath
  });
  return Number.parseInt(result.stdout.trim(), 10);
}

export async function detectRemoteInfo(worktreePath: string): Promise<RemoteInfo> {
  const result = await runCommandOrThrow("git", ["remote", "get-url", "origin"], { cwd: worktreePath });
  return parseRemoteUrl(result.stdout.trim());
}

export function parseRemoteUrl(remoteUrl: string): RemoteInfo {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const provider = providerFromHost(normalized.host);
  const parts = normalized.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new DevtaskError(`Unsupported origin remote URL: ${remoteUrl}`);
  }

  return {
    provider,
    owner: parts[0],
    repo: parts[1],
    remoteUrl
  };
}

async function createGitHubPullRequest(worktreePath: string, options: PullRequestOptions): Promise<string> {
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

async function createBitbucketPullRequest(
  worktreePath: string,
  remote: RemoteInfo,
  options: PullRequestOptions
): Promise<string> {
  if (options.draft) {
    throw new DevtaskError("Bitbucket does not support draft pull requests. Use --ready.");
  }

  const username = process.env.BITBUCKET_EMAIL ?? process.env.BITBUCKET_USERNAME;
  const apiToken = process.env.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD;
  if (!username || !apiToken) {
    throw new DevtaskError("Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN to create Bitbucket pull requests");
  }

  await verifyBitbucketRepositoryAccess(username, apiToken, remote);
  await pushBranch(worktreePath, options.branch);

  const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}/pullrequests`, {
    method: "POST",
    headers: {
      Authorization: bitbucketBasicAuthHeader(username, apiToken),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      title: options.title,
      description: options.body,
      source: {
        branch: {
          name: options.branch
        }
      },
      close_source_branch: false
    })
  });

  if (!response.ok) {
    throw new DevtaskError(formatBitbucketApiError(response.status, await response.text()));
  }

  const payload = (await response.json()) as unknown;
  const href = extractBitbucketPullRequestHref(payload);
  if (!href) {
    throw new DevtaskError("Bitbucket did not return a pull request URL");
  }
  return href;
}

async function verifyBitbucketRepositoryAccess(username: string, apiToken: string, remote: RemoteInfo): Promise<void> {
  const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}`, {
    headers: {
      Authorization: bitbucketBasicAuthHeader(username, apiToken),
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new DevtaskError(formatBitbucketApiError(response.status, await response.text()));
  }
}

async function createGitLabMergeRequest(worktreePath: string, options: PullRequestOptions): Promise<string> {
  if (options.draft) {
    throw new DevtaskError("GitLab draft merge requests are not supported yet. Use --ready.");
  }

  await runCommandOrThrow("glab", ["--version"], { cwd: worktreePath });
  await pushBranch(worktreePath, options.branch);
  const result = await runCommandOrThrow(
    "glab",
    ["mr", "create", "--title", options.title, "--description", options.body, "--source-branch", options.branch],
    { cwd: worktreePath }
  );
  const url = result.stdout.trim().split("\n").find((line) => line.startsWith("http"));
  if (!url) {
    throw new DevtaskError("glab did not return a merge request URL");
  }
  return url;
}

async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await runCommandOrThrow("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
}

async function findPublishBaseRef(worktreePath: string): Promise<string> {
  const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    const result = await runCommand("git", ["rev-parse", "--verify", candidate], { cwd: worktreePath });
    if (result.exitCode === 0) {
      return candidate;
    }
  }
  throw new DevtaskError("Cannot determine the base branch for PR publishing");
}

function normalizeRemoteUrl(remoteUrl: string): URL {
  if (/^[^@/:]+@[^:]+:.+$/.test(remoteUrl)) {
    const [userHost, path] = remoteUrl.split(":", 2);
    const host = userHost.split("@").at(-1);
    if (!host) {
      throw new DevtaskError(`Unsupported origin remote URL: ${remoteUrl}`);
    }
    return new URL(`ssh://${host}/${path}`);
  }

  try {
    return new URL(remoteUrl);
  } catch {
    throw new DevtaskError(`Unsupported origin remote URL: ${remoteUrl}`);
  }
}

function providerFromHost(host: string): ScmProvider {
  if (host === "github.com" || host.endsWith(".github.com")) {
    return "github";
  }
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) {
    return "bitbucket";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return "gitlab";
  }
  throw new DevtaskError(`Unsupported SCM provider for origin host: ${host}`);
}

function extractBitbucketPullRequestHref(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const links = payload.links;
  if (!isRecord(links)) {
    return null;
  }
  const html = links.html;
  if (!isRecord(html) || typeof html.href !== "string") {
    return null;
  }
  return html.href;
}

function formatBitbucketApiError(status: number, body: string): string {
  if (status === 401) {
    return [
      `Bitbucket PR creation failed: ${status} ${body}`,
      "",
      "Check Bitbucket auth:",
      "- BITBUCKET_EMAIL must be your Atlassian account email, not the workspace or repo name.",
      "- BITBUCKET_API_TOKEN must be the generated API token value.",
      "- New Bitbucket API tokens can take up to a minute to become active.",
      "- Token scopes must include repository read/write and pull request read/write.",
      "- devtask validates access against the target repository before pushing."
    ].join("\n");
  }

  return `Bitbucket PR creation failed: ${status} ${body}`;
}

function bitbucketBasicAuthHeader(username: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${username}:${apiToken}`).toString("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
