import { Buffer } from "node:buffer";
import type { DevtaskConfig } from "../../infra/config.js";
import { DevtaskError } from "../../infra/errors.js";
import { runCommand, runCommandOrThrow } from "../../infra/process-runner.js";

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

export interface ScmPreflight {
  provider: ScmProvider | "unknown";
  access: "ok" | "failed";
  accessDetail: string | null;
  clean: boolean;
  commits: number;
  draftSupported: boolean;
}

export interface CiCheckResult {
  provider: ScmProvider;
  status: "passed" | "failed" | "running" | "unknown";
  detail: string;
  url: string | null;
}

export interface PullRequestSummary {
  id: string;
  number: string;
  title: string;
  branch: string;
  url: string | null;
}

export interface PullRequestComment {
  id: string;
  body: string;
  author: string | null;
  createdAt: string | null;
  url: string | null;
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

export async function preflightScmForPullRequest(
  worktreePath: string,
  options: { draft: boolean },
  config?: DevtaskConfig
): Promise<ScmPreflight> {
  try {
    const remote = await detectRemoteInfo(worktreePath);
    if (config?.scm.provider && config.scm.provider !== remote.provider) {
      return {
        provider: remote.provider,
        access: "failed",
        accessDetail: `workspace SCM provider is configured as ${config.scm.provider}, but the repo remote resolves to ${remote.provider}`,
        clean: false,
        commits: 0,
        draftSupported: remote.provider === "github"
      };
    }
    const clean = !(await hasUncommittedChanges(worktreePath));
    const commits = await countBranchCommits(worktreePath);
    const draftSupported = remote.provider === "github";
    const auth = await preflightProviderAuth(remote);
    return {
      provider: remote.provider,
      access: auth.ok ? "ok" : "failed",
      accessDetail: auth.detail,
      clean,
      commits,
      draftSupported
    };
  } catch (error) {
    return {
      provider: "unknown",
      access: "failed",
      accessDetail: error instanceof Error ? error.message : String(error),
      clean: false,
      commits: 0,
      draftSupported: false
    };
  }
}

export async function createGitLabMergeRequest(worktreePath: string, options: PullRequestOptions): Promise<string> {
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

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await runCommandOrThrow("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
}

export async function verifyBitbucketRepositoryAccess(username: string, apiToken: string, remote: RemoteInfo): Promise<void> {
  const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}`, {
    headers: {
      Authorization: bitbucketBasicAuthHeader(username, apiToken),
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new DevtaskError(formatBitbucketApiError("Bitbucket repository access check", response.status, await response.text()));
  }
}

export function bitbucketBasicAuthHeader(username: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${username}:${apiToken}`).toString("base64")}`;
}

export function formatBitbucketApiError(action: string, status: number, body: string): string {
  if (status === 401) {
    return [
      `${action} failed: ${status} ${body}`,
      "",
      "Check Bitbucket auth:",
      "- BITBUCKET_EMAIL must be your Atlassian account email, not the workspace or repo name.",
      "- BITBUCKET_API_TOKEN must be the generated API token value.",
      "- New Bitbucket API tokens can take up to a minute to become active.",
      "- PR creation needs repository read/write and pull request read/write scopes.",
      "- CI checks need pipeline read scope.",
      "- devtask validates access against the target repository before pushing or checking CI."
    ].join("\n");
  }

  return `${action} failed: ${status} ${body}`;
}

export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

export function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function preflightProviderAuth(remote: RemoteInfo): Promise<{ ok: boolean; detail: string | null }> {
  try {
    switch (remote.provider) {
      case "github":
        await runCommandOrThrow("gh", ["--version"], { cwd: process.cwd() });
        return { ok: true, detail: null };
      case "bitbucket": {
        const username = process.env.BITBUCKET_EMAIL ?? process.env.BITBUCKET_USERNAME;
        const apiToken = process.env.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD;
        if (!username || !apiToken) {
          return { ok: false, detail: "missing BITBUCKET_EMAIL or BITBUCKET_API_TOKEN" };
        }
        await verifyBitbucketRepositoryAccess(username, apiToken, remote);
        return { ok: true, detail: null };
      }
      case "gitlab":
        await runCommandOrThrow("glab", ["--version"], { cwd: process.cwd() });
        return { ok: true, detail: null };
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
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
