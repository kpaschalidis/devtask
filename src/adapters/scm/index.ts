import type { DevtaskConfig } from "../../infra/config.js";
import { DevtaskError } from "../../infra/errors.js";
import { checkBitbucketCi, createBitbucketPullRequest } from "./bitbucket.js";
import { checkGitHubCi, createGitHubPullRequest } from "./github.js";
import {
  createGitLabMergeRequest,
  detectRemoteInfo,
  hasUncommittedChanges,
  countBranchCommits,
  parseRemoteUrl,
  preflightScmForPullRequest
} from "./shared.js";
import type { CiCheckResult, PullRequestOptions } from "./shared.js";

export type { CiCheckResult, PullRequestOptions, RemoteInfo, ScmPreflight, ScmProvider } from "./shared.js";
export { countBranchCommits, detectRemoteInfo, hasUncommittedChanges, parseRemoteUrl, preflightScmForPullRequest } from "./shared.js";

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

function assertExpectedWorkspaceProvider(config: DevtaskConfig | undefined, actualProvider: string): void {
  const expectedProvider = config?.scm.provider;
  if (expectedProvider && expectedProvider !== actualProvider) {
    throw new DevtaskError(
      `Workspace SCM provider is configured as ${expectedProvider}, but the repo remote resolves to ${actualProvider}.`
    );
  }
}
