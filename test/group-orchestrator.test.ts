import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGroupOrchestrationPromptForTest,
  groupOrchestrationAddDirsForTest,
  groupOrchestrationPath,
  hasGroupOrchestration,
  isFreshOrchestrationArtifactForTest,
  readGroupOrchestration
} from "../src/group-orchestrator.js";
import { addRepoToGroup, createGroup } from "../src/group-store.js";
import { planMarkdownPath, resolvePaths, taskDir, worktreePath } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("group orchestrator", () => {
  it("stores and reads the durable group orchestration artifact", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    createGroup(paths, "feature-x");

    expect(hasGroupOrchestration(paths, "feature-x")).toBe(false);
    fs.writeFileSync(groupOrchestrationPath(paths, "feature-x"), "# Group Orchestration\n\nContract.\n");

    expect(hasGroupOrchestration(paths, "feature-x")).toBe(true);
    expect(readGroupOrchestration(paths, "feature-x")).toContain("Contract.");
  });

  it("builds a read-only orchestration prompt with repo responsibilities and contracts", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const backendRepo = await makeTempRepo({ withCommit: true });
    const webRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    const group = createGroup(paths, "billing-export", { goal: "Add billing export across backend and web" });
    addRepoToGroup(paths, group.id, {
      name: "backend",
      repoPath: backendRepo,
      taskId: "billing-export-backend"
    });
    const updated = addRepoToGroup(paths, group.id, {
      name: "web",
      repoPath: webRepo,
      taskId: "billing-export-web"
    });
    const backendPaths = resolvePaths(backendRepo);
    fs.mkdirSync(path.dirname(planMarkdownPath(backendPaths, "billing-export-backend")), { recursive: true });
    fs.writeFileSync(planMarkdownPath(backendPaths, "billing-export-backend"), "# Backend Plan\n\nOwns export API.\n");

    const prompt = buildGroupOrchestrationPromptForTest(
      paths,
      updated,
      path.join(paths.groupsDir, updated.id, "orchestration.md")
    );

    expect(prompt).toContain("You are in the devtask group orchestration stage.");
    expect(prompt).toContain("Do not implement code.");
    expect(prompt).toContain("Cross-Repo Contract");
    expect(prompt).toContain("Repo Responsibilities");
    expect(prompt).toContain("Dependencies and Execution Order");
    expect(prompt).toContain("Ownership Boundaries");
    expect(prompt).toContain("Repo task artifacts:");
    expect(prompt).toContain("backend");
    expect(prompt).toContain("billing-export-backend");
    expect(prompt).toContain(planMarkdownPath(backendPaths, "billing-export-backend"));
    expect(prompt).toContain("web");
    expect(prompt).toContain("billing-export-web");
    expect(prompt).toContain("If repo-local plans already exist");
  });

  it("adds repo task and worktree directories to the Codex sandbox", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const backendRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    const group = createGroup(paths, "billing-export", { goal: "Add billing export" });
    const updated = addRepoToGroup(paths, group.id, {
      name: "backend",
      repoPath: backendRepo,
      taskId: "billing-export-backend"
    });
    const backendPaths = resolvePaths(backendRepo);
    fs.mkdirSync(taskDir(backendPaths, "billing-export-backend"), { recursive: true });
    fs.mkdirSync(worktreePath(backendPaths, "billing-export-backend"), { recursive: true });

    expect(groupOrchestrationAddDirsForTest(updated)).toEqual([
      taskDir(backendPaths, "billing-export-backend"),
      worktreePath(backendPaths, "billing-export-backend")
    ]);
  });

  it("rejects stale orchestration artifacts", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    createGroup(paths, "feature-x");
    const artifactPath = groupOrchestrationPath(paths, "feature-x");
    fs.writeFileSync(artifactPath, "# Old Plan\n");
    const previous = { exists: true, mtimeMs: fs.statSync(artifactPath).mtimeMs };

    expect(isFreshOrchestrationArtifactForTest(artifactPath, previous)).toBe(false);

    const nextMtime = new Date(previous.mtimeMs + 1000);
    fs.writeFileSync(artifactPath, "# New Plan\n");
    fs.utimesSync(artifactPath, nextMtime, nextMtime);

    expect(isFreshOrchestrationArtifactForTest(artifactPath, previous)).toBe(true);
  });
});
