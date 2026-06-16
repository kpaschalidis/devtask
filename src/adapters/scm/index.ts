import type { DevtaskConfig } from "../../infra/config.js";
import { DevtaskError } from "../../infra/errors.js";
import { checkBitbucketCi, createBitbucketPullRequest } from "./bitbucket.js";
import { checkGitHubCi, createGitHubPullRequest } from "./github.js";
import {
  createGitLabMergeRequest,
  detectRemoteInfo,
  hasUncommittedChanges,
  type PullRequestComment,
  countBranchCommits,
  parseRemoteUrl,
  preflightScmForPullRequest,
  pushBranchUpdate
} from "./shared.js";
import type { CiCheckResult, PullRequestOptions, PullRequestSummary } from "./shared.js";
import { listBitbucketPullRequestComments, listBitbucketPullRequests } from "./bitbucket.js";
import { listGitHubPullRequestComments, listGitHubPullRequests } from "./github.js";

export type {
  CiCheckResult,
  PullRequestComment,
  PullRequestOptions,
  PullRequestSummary,
  RemoteInfo,
  ScmPreflight,
  ScmProvider
} from "./shared.js";
export { countBranchCommits, detectRemoteInfo, hasUncommittedChanges, parseRemoteUrl, preflightScmForPullRequest } from "./shared.js";
export { pushBranchUpdate } from "./shared.js";

export async function createProviderPullRequest(
  worktreePath: string,
  options: PullRequestOptions,
  config?: DevtaskConfig
): Promise<string> {
  const remote = await detectRemoteInfo(worktreePath);
  assertExpectedWorkspaceProvider(config, remote.provider);

  switch (remote.provider) {
    case "github":
      return createGitHubPullRequest(worktreePath, options);
    case "bitbucket":
      return createBitbucketPullRequest(worktreePath, remote, options);
    case "gitlab":
      return createGitLabMergeRequest(worktreePath, options);
  }
}

export async function checkProviderCi(
  worktreePath: string,
  prUrl: string,
  branch: string,
  config?: DevtaskConfig
): Promise<CiCheckResult> {
  const remote = await detectRemoteInfo(worktreePath);
  assertExpectedWorkspaceProvider(config, remote.provider);

  switch (remote.provider) {
    case "github":
      return checkGitHubCi(worktreePath, prUrl);
    case "bitbucket":
      return checkBitbucketCi(remote, branch);
    case "gitlab":
      throw new DevtaskError("GitLab CI checks are not supported yet");
  }
}

export async function listProviderPullRequests(worktreePath: string, config?: DevtaskConfig): Promise<PullRequestSummary[]> {
  const remote = await detectRemoteInfo(worktreePath);
  assertExpectedWorkspaceProvider(config, remote.provider);

  switch (remote.provider) {
    case "github":
      return listGitHubPullRequests(worktreePath);
    case "bitbucket":
      return listBitbucketPullRequests(remote);
    case "gitlab":
      throw new DevtaskError("GitLab pull request watching is not supported yet");
  }
}

export async function listProviderPullRequestComments(
  worktreePath: string,
  pullRequestId: string,
  config?: DevtaskConfig
): Promise<PullRequestComment[]> {
  const remote = await detectRemoteInfo(worktreePath);
  assertExpectedWorkspaceProvider(config, remote.provider);

  switch (remote.provider) {
    case "github":
      return listGitHubPullRequestComments(worktreePath, pullRequestId);
    case "bitbucket":
      return listBitbucketPullRequestComments(remote, pullRequestId);
    case "gitlab":
      throw new DevtaskError("GitLab pull request watching is not supported yet");
  }
}

function assertExpectedWorkspaceProvider(config: DevtaskConfig | undefined, actualProvider: string): void {
  const expectedProvider = config?.scm.provider;
  if (expectedProvider && expectedProvider !== actualProvider) {
    throw new DevtaskError(
      `Workspace SCM provider is configured as ${expectedProvider}, but the repo remote resolves to ${actualProvider}.`
    );
  }
}
