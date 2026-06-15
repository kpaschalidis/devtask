import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateBoardHtmlReports } from "../src/board/html.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace, createTask } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { writeTaskMeta } from "../src/storage/meta.js";
import { registerWorkspace } from "../src/storage/global-index.js";
import { makeTempRepo } from "./helpers.js";

describe("board html service", () => {
  const originalHome = process.env.DEVTASK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.DEVTASK_HOME;
    } else {
      process.env.DEVTASK_HOME = originalHome;
    }
  });

  it("generates a report for one requested workspace", async () => {
    process.env.DEVTASK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-html-one-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspaceRoot);
    initializeWorkspace(paths);
    registerWorkspace(paths, "platform");

    const item = createManualWorkItem(paths, {
      id: "APP-123",
      title: "Add board report"
    });
    const task = await createTask(paths, "app-123-backend", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "backend", "app-123-backend")
    });
    writeTaskMeta(path.join(paths.tasksDir, task.id, "meta.json"), {
      ...task,
      status: "ready",
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        workId: item.id,
        graphSnapshotPath: path.join(paths.localDir, "work", item.id, "graph.snapshot.json"),
        materializedAt: new Date().toISOString(),
        tasks: [{
          graphTaskId: task.id,
          repoId: "backend",
          repoPath: repo,
          scope: null,
          taskId: task.id,
          branch: task.branch,
          worktreePath: task.worktreePath
        }]
      }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-html-out-"));
    const reports = await generateBoardHtmlReports({ workspaceId: "platform", outDir });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.workspaceId).toBe("platform");
    expect(fs.readFileSync(path.join(outDir, "index.html"), "utf8")).toContain("Workspace Reports");
    const html = fs.readFileSync(path.join(outDir, "workspaces", "platform.html"), "utf8");
    expect(html).toContain("APP-123");
    expect(html).toContain("Add board report");
    expect(html).toContain("devtask work execute APP-123");
  });

  it("generates one page per registered workspace when no workspace is provided", async () => {
    process.env.DEVTASK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-html-many-"));
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-html-first-"));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-html-second-"));

    const first = resolveWorkspacePathsForInit(firstRoot);
    initializeWorkspace(first);
    registerWorkspace(first, "alpha");
    createManualWorkItem(first, { id: "ALPHA-1", title: "Alpha work" });

    const second = resolveWorkspacePathsForInit(secondRoot);
    initializeWorkspace(second);
    registerWorkspace(second, "beta");
    createManualWorkItem(second, { id: "BETA-1", title: "Beta work" });

    const reports = await generateBoardHtmlReports({ outDir });

    expect(reports.map((report) => report.workspaceId)).toEqual(["alpha", "beta"]);
    const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    expect(indexHtml).toContain("./workspaces/alpha.html");
    expect(indexHtml).toContain("./workspaces/beta.html");
    expect(fs.existsSync(path.join(outDir, "workspaces", "alpha.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "workspaces", "beta.html"))).toBe(true);
  });
});
