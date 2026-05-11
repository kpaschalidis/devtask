import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildJiraTaskGoal,
  checkJiraAuth,
  fetchJiraIssue,
  normalizeJiraIssue,
  writeJiraSourceArtifacts
} from "../src/jira.js";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("jira source integration", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.JIRA_API_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.JIRA_API_TOKEN;
    } else {
      process.env.JIRA_API_TOKEN = originalToken;
    }
  });

  it("normalizes Jira issue responses and renders ADF descriptions", async () => {
    const issue = normalizeJiraIssue(
      {
        key: "APP-123",
        fields: {
          summary: "Add billing export",
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Export billing data." }]
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "CSV format" }] }]
                  }
                ]
              }
            ]
          },
          status: { name: "In Progress" },
          issuetype: { name: "Story" },
          assignee: { displayName: "Dev User", emailAddress: "dev@example.com" },
          reporter: { displayName: "PM User" },
          labels: ["billing"],
          components: [{ name: "Backend" }]
        }
      },
      "https://company.atlassian.net"
    );

    expect(issue).toMatchObject({
      key: "APP-123",
      summary: "Add billing export",
      status: "In Progress",
      issueType: "Story",
      assignee: "Dev User <dev@example.com>",
      reporter: "PM User",
      labels: ["billing"],
      components: ["Backend"],
      url: "https://company.atlassian.net/browse/APP-123"
    });
    expect(issue.description).toContain("Export billing data.");
    expect(issue.description).toContain("- CSV format");
  });

  it("writes durable Jira source artifacts and task goals", async () => {
    const workspace = await makeTempRepo();
    const paths = resolveWorkspacePathsForInit(workspace);
    const issue = normalizeJiraIssue(
      {
        key: "APP-123",
        fields: {
          summary: "Add billing export",
          description: "Plain description"
        }
      },
      "https://company.atlassian.net"
    );

    const artifacts = writeJiraSourceArtifacts(paths, issue);

    expect(fs.existsSync(artifacts.jsonPath)).toBe(true);
    expect(fs.readFileSync(artifacts.markdownPath, "utf8")).toContain("# APP-123: Add billing export");
    expect(buildJiraTaskGoal(issue, artifacts.markdownPath)).toContain("Jira source artifact");
    expect(buildJiraTaskGoal(issue, artifacts.markdownPath)).toContain("Plain description");
  });

  it("uses Atlassian gateway URLs when cloudId is configured", async () => {
    process.env.JIRA_API_TOKEN = "token";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          key: "APP-123",
          fields: {
            summary: "Add billing export",
            description: "Plain description"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    await fetchJiraIssue(
      {
        schemaVersion: 1,
        codex: { model: null, fullAuto: true },
        runtime: { mode: "plain", backend: null },
        runtimeConfigured: false,
        jira: {
          baseUrl: "https://company.atlassian.net",
          email: "dev@example.com",
          cloudId: "cloud-123"
        },
        verify: []
      },
      "APP-123"
    );

    expect(calls[0]).toBe("https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/APP-123");
  });

  it("checks Jira auth through the configured API mode", async () => {
    process.env.JIRA_API_TOKEN = "token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accountId: "account-1", displayName: "Dev User" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;

    await expect(
      checkJiraAuth({
        schemaVersion: 1,
        codex: { model: null, fullAuto: true },
        runtime: { mode: "plain", backend: null },
        runtimeConfigured: false,
        jira: {
          baseUrl: "https://company.atlassian.net",
          email: "dev@example.com",
          cloudId: "cloud-123"
        },
        verify: []
      })
    ).resolves.toEqual({
      accountId: "account-1",
      displayName: "Dev User",
      mode: "gateway"
    });
  });
});
