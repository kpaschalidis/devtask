import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPhaseMemory } from "../src/improvement-memory.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

describe("improvement memory", () => {
  it("loads shared, local, repo-scoped, and archived guidance for a phase", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-improvement-memory-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    const sharedPlanning = path.join(paths.sharedDir, "improvement", "planning.md");
    const localPlanning = path.join(paths.localDir, "improvement", "planning.md");
    const repoPlanning = path.join(paths.sharedDir, "improvement", "repos", "backend", "planning.md");
    const archivedPlanning = path.join(paths.sharedDir, "improvement", "archive", "WORK-1", "planning.md");
    fs.mkdirSync(path.dirname(sharedPlanning), { recursive: true });
    fs.mkdirSync(path.dirname(localPlanning), { recursive: true });
    fs.mkdirSync(path.dirname(repoPlanning), { recursive: true });
    fs.mkdirSync(path.dirname(archivedPlanning), { recursive: true });
    fs.writeFileSync(sharedPlanning, "# Shared\nshared guidance\n");
    fs.writeFileSync(localPlanning, "# Local\nlocal guidance\n");
    fs.writeFileSync(repoPlanning, "# Repo\nrepo guidance\n");
    fs.writeFileSync(archivedPlanning, "# Archived\narchived guidance\n");

    const memory = collectPhaseMemory(paths, "planning", { repoId: "backend" });

    expect(memory).toContain("shared guidance");
    expect(memory).toContain("local guidance");
    expect(memory).toContain("repo guidance");
    expect(memory).toContain("archived guidance");
  });
});
