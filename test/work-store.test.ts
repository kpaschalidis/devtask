import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeJiraIssue, writeJiraSourceArtifacts } from "../src/adapters/jira.js";
import { resolveWorkspacePathsForInit, workItemJsonPath, workItemSourcePath, workItemStatePath } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { createJiraWorkItem, createManualWorkItem, getWorkItem, listWorkItems } from "../src/work-store.js";

describe("work store", () => {
  it("creates durable manual work items", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-store-manual-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    const item = createManualWorkItem(paths, {
      id: "manual-1",
      title: "Improve onboarding",
      body: "Clarify install steps."
    });

    expect(item).toMatchObject({
      schemaVersion: 1,
      id: "manual-1",
      status: "created",
      source: {
        type: "manual",
        title: "Improve onboarding",
        artifact: workItemSourcePath(paths, "manual-1")
      }
    });
    expect(fs.readFileSync(workItemSourcePath(paths, "manual-1"), "utf8")).toContain("Clarify install steps.");
    expect(fs.existsSync(workItemJsonPath(paths, "manual-1"))).toBe(true);
    expect(fs.existsSync(workItemStatePath(paths, "manual-1"))).toBe(true);
    expect(getWorkItem(paths, "manual-1").source.type).toBe("manual");
  });

  it("creates Jira-backed work items from existing source artifacts", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-store-jira-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
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

    const item = createJiraWorkItem(paths, {
      id: issue.key,
      key: issue.key,
      title: issue.summary,
      url: issue.url,
      artifact: artifacts.markdownPath
    });

    expect(item.source).toMatchObject({
      type: "jira",
      key: "APP-123",
      title: "Add billing export",
      artifact: artifacts.markdownPath
    });
    expect(listWorkItems(paths).map((workItem) => workItem.id)).toEqual(["APP-123"]);
  });

  it("rejects duplicate work items", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-store-duplicate-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, {
      id: "manual-1",
      title: "Improve onboarding"
    });

    expect(() =>
      createManualWorkItem(paths, {
        id: "manual-1",
        title: "Improve onboarding again"
      })
    ).toThrow("already exists");
  });

  it("lists work items sorted", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-store-list-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, {
      id: "z-work",
      title: "Z work"
    });
    createManualWorkItem(paths, {
      id: "a-work",
      title: "A work"
    });

    expect(listWorkItems(paths).map((item) => item.id)).toEqual(["a-work", "z-work"]);
  });
});
