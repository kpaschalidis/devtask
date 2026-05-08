import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildJiraGroupRepoGoal,
  buildJiraTaskGoal,
  normalizeJiraIssue,
  writeJiraSourceArtifacts
} from "../src/jira.js";
import { resolveWorkspacePathsForInit } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("jira source integration", () => {
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
    expect(buildJiraGroupRepoGoal(issue, "app-123", "backend", artifacts.markdownPath)).toContain("backend part");
    expect(buildJiraGroupRepoGoal(issue, "app-123", "backend", artifacts.markdownPath)).toContain("Plain description");
  });
});
