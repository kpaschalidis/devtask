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

export async function checkProviderCi(worktreePath: string, prUrl: string, branch: string): Promise<CiCheckResult> {
  const remote = await detectRemoteInfo(worktreePath);

  switch (remote.provider) {
    case "github":
      return checkGitHubCi(worktreePath, prUrl);
    case "bitbucket":
      return checkBitbucketCi(remote, branch);
    case "gitlab":
      throw new DevtaskError("GitLab CI checks are not supported yet");
  }
}
