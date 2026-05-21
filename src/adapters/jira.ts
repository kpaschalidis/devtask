import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string | null;
  issueType: string | null;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  components: string[];
  url: string;
  raw: unknown;
}

export interface JiraSourceArtifacts {
  jsonPath: string;
  markdownPath: string;
}

interface JiraFetchResponse {
  key?: unknown;
  fields?: {
    summary?: unknown;
    description?: unknown;
    status?: { name?: unknown };
    issuetype?: { name?: unknown };
    assignee?: { displayName?: unknown; emailAddress?: unknown } | null;
    reporter?: { displayName?: unknown; emailAddress?: unknown } | null;
    labels?: unknown;
    components?: unknown;
  };
}

export interface JiraAuth {
  baseUrl: string;
  apiBaseUrl: string;
  email: string;
  token: string;
  mode: "site" | "gateway";
}

export function assertJiraConfigured(config: DevtaskConfig): JiraAuth {
  const token = process.env.JIRA_API_TOKEN;
  if (config.tracker.provider && config.tracker.provider !== "jira") {
    throw new DevtaskError(`Workspace tracker is configured as ${config.tracker.provider}, not jira.`);
  }
  if (!config.jira.baseUrl || !config.jira.email) {
    throw new DevtaskError("Jira is not configured. Run devtask config jira --base-url <url> --email <email>.");
  }
  if (!token) {
    throw new DevtaskError("JIRA_API_TOKEN is not set.");
  }

  return {
    baseUrl: config.jira.baseUrl,
    apiBaseUrl: jiraApiBaseUrl(config),
    email: config.jira.email,
    token,
    mode: config.jira.cloudId ? "gateway" : "site"
  };
}

export async function fetchJiraIssue(config: DevtaskConfig, issueKey: string): Promise<JiraIssue> {
  const auth = assertJiraConfigured(config);
  const response = await fetchJiraWithAuthFallback(auth, `/issue/${encodeURIComponent(issueKey)}`);

  if (!response.ok) {
    throw new DevtaskError(`Jira issue fetch failed: ${response.status} ${await response.text()}`);
  }

  return normalizeJiraIssue((await response.json()) as JiraFetchResponse, auth.baseUrl);
}

export async function checkJiraAuth(config: DevtaskConfig): Promise<{ accountId: string | null; displayName: string | null; mode: JiraAuth["mode"] }> {
  const auth = assertJiraConfigured(config);
  const response = await fetchJiraWithAuthFallback(auth, "/myself");
  if (!response.ok) {
    throw new DevtaskError(`Jira auth check failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { accountId?: unknown; displayName?: unknown };
  return {
    accountId: optionalString(body.accountId),
    displayName: optionalString(body.displayName),
    mode: auth.mode
  };
}

function jiraApiBaseUrl(config: DevtaskConfig): string {
  if (!config.jira.baseUrl) {
    throw new DevtaskError("Jira is not configured. Run devtask config jira --base-url <url> --email <email>.");
  }
  if (config.jira.cloudId) {
    return `https://api.atlassian.com/ex/jira/${encodeURIComponent(config.jira.cloudId)}/rest/api/3`;
  }
  return `${config.jira.baseUrl}/rest/api/3`;
}

async function fetchJiraWithAuthFallback(auth: JiraAuth, apiPath: string): Promise<Response> {
  let lastResponse: Response | null = null;
  for (const authorization of jiraAuthHeaders(auth)) {
    const response = await fetch(`${auth.apiBaseUrl}${apiPath}`, {
      headers: {
        Authorization: authorization,
        Accept: "application/json"
      }
    });
    if (response.ok || !shouldTryNextJiraAuth(response.status)) {
      return response;
    }
    lastResponse = response;
  }
  return lastResponse ?? new Response("No Jira auth methods available", { status: 401 });
}

function jiraAuthHeaders(auth: JiraAuth): string[] {
  const basic = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`;
  if (auth.mode === "gateway") {
    return [`Bearer ${auth.token}`, basic];
  }
  return [basic];
}

function shouldTryNextJiraAuth(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function normalizeJiraIssue(value: JiraFetchResponse, baseUrl: string): JiraIssue {
  const fields = value.fields ?? {};
  const key = requireString(value.key, "issue key");
  return {
    key,
    summary: requireString(fields.summary, "issue summary"),
    description: jiraDocumentToText(fields.description),
    status: optionalString(fields.status?.name),
    issueType: optionalString(fields.issuetype?.name),
    assignee: userToString(fields.assignee),
    reporter: userToString(fields.reporter),
    labels: stringArray(fields.labels),
    components: componentArray(fields.components),
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`,
    raw: value
  };
}

export function writeJiraSourceArtifacts(paths: DevtaskPaths, issue: JiraIssue): JiraSourceArtifacts {
  const dir = path.join(paths.sharedDir, "sources", "jira");
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${issue.key}.json`);
  const markdownPath = path.join(dir, `${issue.key}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(issue, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderJiraIssueMarkdown(issue));
  return { jsonPath, markdownPath };
}

export function renderJiraIssueMarkdown(issue: JiraIssue): string {
  return [
    `# ${issue.key}: ${issue.summary}`,
    "",
    `URL: ${issue.url}`,
    `Status: ${issue.status ?? "-"}`,
    `Type: ${issue.issueType ?? "-"}`,
    `Assignee: ${issue.assignee ?? "-"}`,
    `Reporter: ${issue.reporter ?? "-"}`,
    `Labels: ${issue.labels.length ? issue.labels.join(", ") : "-"}`,
    `Components: ${issue.components.length ? issue.components.join(", ") : "-"}`,
    "",
    "## Description",
    "",
    issue.description || "-",
    ""
  ].join("\n");
}

export function buildJiraTaskGoal(issue: JiraIssue, sourcePath: string): string {
  return [
    `Implement Jira issue ${issue.key}: ${issue.summary}`,
    "",
    `Jira source artifact: ${sourcePath}`,
    `Jira URL: ${issue.url}`,
    "",
    "Use the Jira issue description as the source of truth. Inspect the repository first, follow local conventions, keep changes scoped, and update relevant tests/docs.",
    "",
    "## Jira Issue",
    "",
    renderJiraIssueMarkdown(issue).trim()
  ].join("\n");
}

function jiraDocumentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  return renderAdfNode(value).replace(/\n{3,}/g, "\n\n").trim();
}

function renderAdfNode(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const node = value as { type?: unknown; text?: unknown; content?: unknown; attrs?: { url?: unknown } };
  const content = Array.isArray(node.content) ? node.content.map(renderAdfNode).join("") : "";
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "paragraph":
      return `${content}\n\n`;
    case "heading":
      return `## ${content.trim()}\n\n`;
    case "bulletList":
    case "orderedList":
      return `${content}\n`;
    case "listItem":
      return `- ${content.trim()}\n`;
    case "hardBreak":
      return "\n";
    case "blockquote":
      return content
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n";
    case "codeBlock":
      return `\`\`\`\n${content.trim()}\n\`\`\`\n\n`;
    case "inlineCard":
    case "blockCard":
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    default:
      return content;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DevtaskError(`Jira response is missing ${label}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function componentArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "object" && item !== null ? (item as { name?: unknown }).name : null))
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function userToString(value: { displayName?: unknown; emailAddress?: unknown } | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const displayName = optionalString(value.displayName);
  const email = optionalString(value.emailAddress);
  if (displayName && email) {
    return `${displayName} <${email}>`;
  }
  return displayName ?? email;
}
