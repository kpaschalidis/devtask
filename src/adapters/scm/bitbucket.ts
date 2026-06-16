import { DevtaskError } from "../../infra/errors.js";
import type { CiCheckResult, PullRequestComment, PullRequestOptions, PullRequestSummary, RemoteInfo } from "./shared.js";
import {
  bitbucketBasicAuthHeader,
  formatBitbucketApiError,
  isRecord,
  pushBranch,
  readNestedString,
  readNumber,
  readString,
  verifyBitbucketRepositoryAccess
} from "./shared.js";

export async function createBitbucketPullRequest(
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
    throw new DevtaskError(formatBitbucketApiError("Bitbucket PR creation", response.status, await response.text()));
  }

  const payload = (await response.json()) as unknown;
  const href = extractBitbucketPullRequestHref(payload);
  if (!href) {
    throw new DevtaskError("Bitbucket did not return a pull request URL");
  }
  return href;
}

export async function checkBitbucketCi(remote: RemoteInfo, branch: string): Promise<CiCheckResult> {
  const username = process.env.BITBUCKET_EMAIL ?? process.env.BITBUCKET_USERNAME;
  const apiToken = process.env.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD;
  if (!username || !apiToken) {
    throw new DevtaskError("Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN to check Bitbucket pipelines");
  }

  const pipeline = await fetchLatestBitbucketPipeline(username, apiToken, remote, branch);
  if (!pipeline) {
    return {
      provider: "bitbucket",
      status: "unknown",
      detail: `No Bitbucket pipeline found for branch ${branch}`,
      url: null
    };
  }
  const stateName = readNestedString(pipeline, ["state", "name"])?.toLowerCase() ?? "unknown";
  const resultName = readNestedString(pipeline, ["state", "result", "name"])?.toLowerCase() ?? null;
  const buildNumber = readNumber(pipeline, "build_number");
  const url = readNestedString(pipeline, ["links", "html", "href"]);
  const label = `pipeline ${buildNumber ?? readString(pipeline, "uuid") ?? "unknown"}: state=${stateName}, result=${resultName ?? "-"}`;
  return {
    provider: "bitbucket",
    status: bitbucketPipelineStatus(stateName, resultName),
    detail: label,
    url,
    failureOutput: resultName && resultName !== "successful" ? label : null
  };
}

function bitbucketPipelineStatus(stateName: string, resultName: string | null): CiCheckResult["status"] {
  if (stateName !== "completed") {
    return stateName === "in_progress" || stateName === "pending" ? "running" : "unknown";
  }
  if (resultName === "successful") {
    return "passed";
  }
  return resultName ? "failed" : "unknown";
}

async function fetchLatestBitbucketPipeline(
  username: string,
  apiToken: string,
  remote: RemoteInfo,
  branch: string
): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}/pipelines`);
  url.searchParams.set("pagelen", "10");
  url.searchParams.set("sort", "-created_on");
  const response = await fetch(url, {
    headers: {
      Authorization: bitbucketBasicAuthHeader(username, apiToken),
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new DevtaskError(formatBitbucketApiError("Bitbucket pipeline check", response.status, await response.text()));
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.values)) {
    throw new DevtaskError("Bitbucket pipelines response was not a paginated list");
  }

  const pipeline = payload.values.find((value) => isRecord(value) && readNestedString(value, ["target", "ref_name"]) === branch);
  if (!isRecord(pipeline)) {
    return null;
  }
  return pipeline;
}

export async function listBitbucketPullRequests(remote: RemoteInfo): Promise<PullRequestSummary[]> {
  const { username, apiToken } = requireBitbucketCredentials("list Bitbucket pull requests");
  const url = new URL(`https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}/pullrequests`);
  url.searchParams.set("state", "OPEN");
  url.searchParams.set("pagelen", "50");
  const payload = await fetchBitbucketJson(url, username, apiToken, "Bitbucket pull request list");
  if (!isRecord(payload) || !Array.isArray(payload.values)) {
    throw new DevtaskError("Bitbucket pull request list response was not a paginated list");
  }

  return payload.values.map((entry) => {
    if (!isRecord(entry)) {
      throw new DevtaskError("Bitbucket pull request entry was not an object");
    }
    return {
      id: requireBitbucketId(entry, "id"),
      number: requireBitbucketId(entry, "id"),
      title: readString(entry, "title") ?? "",
      branch: readNestedString(entry, ["source", "branch", "name"]) ?? "",
      url: readNestedString(entry, ["links", "html", "href"])
    };
  });
}

export async function listBitbucketPullRequestComments(remote: RemoteInfo, pullRequestId: string): Promise<PullRequestComment[]> {
  const { username, apiToken } = requireBitbucketCredentials("list Bitbucket pull request comments");
  const url = new URL(
    `https://api.bitbucket.org/2.0/repositories/${remote.owner}/${remote.repo}/pullrequests/${pullRequestId}/comments`
  );
  url.searchParams.set("pagelen", "100");
  const payload = await fetchBitbucketJson(url, username, apiToken, "Bitbucket pull request comment list");
  if (!isRecord(payload) || !Array.isArray(payload.values)) {
    throw new DevtaskError("Bitbucket pull request comment list response was not a paginated list");
  }

  return payload.values.map((entry) => {
    if (!isRecord(entry)) {
      throw new DevtaskError("Bitbucket pull request comment entry was not an object");
    }
    return {
      id: requireBitbucketId(entry, "id"),
      body: readNestedString(entry, ["content", "raw"]) ?? "",
      author: readNestedString(entry, ["user", "display_name"]),
      createdAt: readString(entry, "created_on"),
      url: readNestedString(entry, ["links", "html", "href"])
    };
  });
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

function requireBitbucketCredentials(action: string): { username: string; apiToken: string } {
  const username = process.env.BITBUCKET_EMAIL ?? process.env.BITBUCKET_USERNAME;
  const apiToken = process.env.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD;
  if (!username || !apiToken) {
    throw new DevtaskError(`Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN to ${action}`);
  }
  return { username, apiToken };
}

async function fetchBitbucketJson(url: URL, username: string, apiToken: string, action: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: bitbucketBasicAuthHeader(username, apiToken),
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new DevtaskError(formatBitbucketApiError(action, response.status, await response.text()));
  }

  return response.json();
}

function requireBitbucketId(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new DevtaskError(`Bitbucket response field ${key} must be a non-empty identifier`);
}
