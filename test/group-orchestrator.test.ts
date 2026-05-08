import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGroupOrchestrationPromptForTest,
  groupOrchestrationPath,
  hasGroupOrchestration,
  readGroupOrchestration
} from "../src/group-orchestrator.js";
import { addRepoToGroup, createGroup } from "../src/group-store.js";
import { resolvePaths } from "../src/paths.js";
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
    expect(prompt).toContain("backend");
    expect(prompt).toContain("billing-export-backend");
    expect(prompt).toContain("web");
    expect(prompt).toContain("billing-export-web");
  });
});
