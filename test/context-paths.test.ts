import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  workItemRepoContextPath,
  workItemLessonProposalsPath,
  lessonProposalsArchivePath
} from "../src/infra/paths.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

describe("context and lesson paths", () => {
  function makeWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-ctx-paths-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    return paths;
  }

  it("workItemRepoContextPath is adjacent to the repo-plan", () => {
    const paths = makeWorkspace();
    const planPath = path.join(paths.workDir, "work-1", "repo-plans", "backend.md");
    const contextPath = workItemRepoContextPath(paths, "work-1", "backend");
    expect(path.dirname(contextPath)).toBe(path.dirname(planPath));
    expect(contextPath).toBe(path.join(paths.workDir, "work-1", "repo-plans", "backend.context.md"));
  });

  it("workItemLessonProposalsPath is under local work dir", () => {
    const paths = makeWorkspace();
    const proposalsPath = workItemLessonProposalsPath(paths, "work-1");
    expect(proposalsPath).toContain(path.join("local", "work", "work-1", "lessons", "proposals.jsonl"));
  });

  it("lessonProposalsArchivePath is under local improvement dir", () => {
    const paths = makeWorkspace();
    const archivePath = lessonProposalsArchivePath(paths);
    expect(archivePath).toContain(path.join("local", "improvement", "proposals-archive.jsonl"));
  });
});
