import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, workItemDir } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { createManualWorkItem } from "../src/work-store.js";
import { buildWorkPlanPromptForTest, workGraphPath, workPlanAddDirsForTest, workPlanPath } from "../src/work-planner.js";
import { makeTempRepo } from "./helpers.js";

describe("work planner", () => {
  it("builds a work planning prompt from source and workspace targets", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-planner-prompt-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "manual-1",
      title: "Improve onboarding",
      body: "Clarify install steps."
    });
    const target = addWorkspaceTarget(paths, {
      id: "docs",
      repoPath: repo,
      kind: "docs"
    });

    const prompt = buildWorkPlanPromptForTest(paths, item, [target], workPlanPath(paths, item.id), workGraphPath(paths, item.id));

    expect(prompt).toContain("You are in the devtask work planning stage.");
    expect(prompt).toContain("Read the work source artifact before planning.");
    expect(prompt).toContain("Improve onboarding");
    expect(prompt).toContain(item.source.artifact);
    expect(prompt).toContain("docs");
    expect(prompt).toContain("Proposed Execution Graph");
    expect(prompt).toContain('"tasks"');
    expect(prompt).toContain("Use only configured workspace targets");
  });

  it("exposes stable plan and graph paths under the work item directory", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-planner-paths-"));
    const paths = resolveWorkspacePathsForInit(workspace);

    expect(workPlanPath(paths, "manual-1")).toBe(path.join(workItemDir(paths, "manual-1"), "plan.md"));
    expect(workGraphPath(paths, "manual-1")).toBe(path.join(workItemDir(paths, "manual-1"), "graph.json"));
  });

  it("allows the planner to read source artifacts and target scopes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-planner-add-dirs-"));
    const repo = await makeTempRepo({ withCommit: true });
    fs.mkdirSync(path.join(repo, "packages", "api"), { recursive: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "manual-1",
      title: "Improve onboarding"
    });
    const target = addWorkspaceTarget(paths, {
      id: "api",
      repoPath: repo,
      scope: "packages/api"
    });

    expect(workPlanAddDirsForTest(item, [target])).toEqual([
      path.dirname(item.source.artifact),
      path.join(target.repoPath, "packages", "api")
    ]);
  });
});
