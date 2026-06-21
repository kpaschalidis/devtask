import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspacePathsForInit,
  workItemMaterializationPath
} from "../src/infra/paths.js";
import { orchestratorPhase } from "../src/roles/orchestrator.js";
import { reviewPhase } from "../src/roles/validator.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { makeTempRepo } from "./helpers.js";

describe("role phase memory", () => {
  it("injects global planning knowledge into orchestration", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-orchestrator-memory-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-1", title: "Plan work" });
    const memoryPath = path.join(paths.sharedDir, "improvement", "planning.md");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, "# Planning\nUse explicit ownership boundaries.\n");

    const fresh = await orchestratorPhase.freshScope(paths, item.id, null, "run-1");

    expect(fresh.prompt).toContain("Use explicit ownership boundaries.");
    expect(fresh.prompt).toContain(`Source: ${memoryPath}`);
  });

  it("injects global and repo-specific review knowledge into validation", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-review-memory-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-2", title: "Review work" });
    const globalMemoryPath = path.join(paths.sharedDir, "improvement", "review.md");
    const repoMemoryPath = path.join(paths.localDir, "improvement", "repos", "backend", "review.md");
    fs.mkdirSync(path.dirname(globalMemoryPath), { recursive: true });
    fs.mkdirSync(path.dirname(repoMemoryPath), { recursive: true });
    fs.writeFileSync(globalMemoryPath, "# Review\nVerify observable behavior.\n");
    fs.writeFileSync(repoMemoryPath, "# Backend review\nCheck migration compatibility.\n");
    fs.mkdirSync(path.dirname(workItemMaterializationPath(paths, item.id)), { recursive: true });
    fs.writeFileSync(
      workItemMaterializationPath(paths, item.id),
      `${JSON.stringify({
        schemaVersion: 1,
        workId: item.id,
        graphSnapshotPath: path.join(paths.localDir, "graph.snapshot.json"),
        materializedAt: new Date().toISOString(),
        tasks: [{
          graphTaskId: "backend-task",
          repoId: "backend",
          repoPath: repo,
          scope: null,
          taskId: "backend-task",
          branch: "feature/work-2-backend",
          worktreePath: repo
        }]
      }, null, 2)}\n`
    );

    const fresh = await reviewPhase.freshScope(paths, item.id, "backend", "run-1");

    expect(fresh.prompt).toContain("Verify observable behavior.");
    expect(fresh.prompt).toContain("Check migration compatibility.");
    expect(fresh.prompt).toContain(`Source: ${repoMemoryPath}`);
  });
});
