import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workItemRepoPlanPath } from "../src/infra/paths.js";
import { addWorkspaceRepo, listRepoBindingStatuses } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { createWorkspace, exportWorkspaceBundle, importWorkspaceBundle } from "../src/services/workspace-service.js";
import { bindRepo, diagnoseRepoBindings } from "../src/services/repo-service.js";
import { makeTempRepo } from "./helpers.js";

describe("workspace bundle onboarding", () => {
  const originalHome = process.env.DEVTASK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.DEVTASK_HOME;
    } else {
      process.env.DEVTASK_HOME = originalHome;
    }
  });

  it("exports and imports a workspace bundle with shared artifacts and hinted repo bindings", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-create-"));
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-import-"));
    const bundle = path.join(os.tmpdir(), `devtask-workspace-${Date.now()}.zip`);
    const repo = await makeTempRepo({ withCommit: true });
    const normalizedRepo = fs.realpathSync(repo);
    process.env.DEVTASK_HOME = home;

    const created = createWorkspace(workspace, { id: "platform", name: "Platform" });
    addWorkspaceRepo(created.paths, {
      id: "backend",
      repoPath: repo,
      kind: "service"
    });
    const item = createManualWorkItem(created.paths, {
      id: "APP-123",
      title: "Add billing export"
    });
    fs.writeFileSync(path.join(created.paths.workDir, item.id, "spec.md"), "# Spec\n");
    fs.writeFileSync(path.join(created.paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(path.join(created.paths.workDir, item.id, "graph.json"), "{\n  \"schemaVersion\": 1,\n  \"tasks\": []\n}\n");
    fs.mkdirSync(path.dirname(workItemRepoPlanPath(created.paths, item.id, "backend")), { recursive: true });
    fs.writeFileSync(workItemRepoPlanPath(created.paths, item.id, "backend"), "# Backend plan\n");

    const exported = await exportWorkspaceBundle({ workspaceId: "platform", outFile: bundle });
    expect(fs.existsSync(exported.outFile)).toBe(true);

    const imported = await importWorkspaceBundle({ file: bundle, root: importRoot });
    expect(imported.paths.workspaceId).toBe("platform");
    expect(fs.existsSync(path.join(imported.paths.sharedDir, "workspace.json"))).toBe(true);
    expect(fs.existsSync(path.join(imported.paths.sharedDir, "repos.json"))).toBe(true);
    expect(fs.existsSync(path.join(imported.paths.workDir, item.id, "spec.md"))).toBe(true);
    expect(fs.existsSync(workItemRepoPlanPath(imported.paths, item.id, "backend"))).toBe(true);

    const bindings = listRepoBindingStatuses(imported.paths);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: "backend",
      pathHint: normalizedRepo,
      repoPath: normalizedRepo,
      bound: true
    });
  });

  it("can rebind an imported workspace repo and report doctor issues", async () => {
    const leadHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-lead-"));
    const joinerHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-joiner-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-create-"));
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-import-"));
    const bundle = path.join(os.tmpdir(), `devtask-workspace-${Date.now()}-bind.zip`);
    const leadRepoPath = path.join(os.tmpdir(), `missing-repo-${Date.now()}`);
    const localRepo = await makeTempRepo({ withCommit: true });
    const normalizedLocalRepo = fs.realpathSync(localRepo);
    process.env.DEVTASK_HOME = leadHome;

    const created = createWorkspace(workspace, { id: "platform", name: "Platform" });
    addWorkspaceRepo(created.paths, {
      id: "backend",
      repoPath: localRepo,
      kind: "service"
    });
    const reposPath = path.join(created.paths.sharedDir, "repos.json");
    const sharedRepos = JSON.parse(fs.readFileSync(reposPath, "utf8")) as {
      schemaVersion: number;
      repos: Array<Record<string, unknown>>;
    };
    sharedRepos.repos[0] = { ...sharedRepos.repos[0], pathHint: leadRepoPath };
    fs.writeFileSync(reposPath, `${JSON.stringify(sharedRepos, null, 2)}\n`);

    await exportWorkspaceBundle({ workspaceId: "platform", outFile: bundle });
    process.env.DEVTASK_HOME = joinerHome;
    await importWorkspaceBundle({ file: bundle, root: importRoot });

    let issues = diagnoseRepoBindings("platform");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("does not exist");

    const rebound = bindRepo("platform", "backend", { path: localRepo });
    expect(rebound.repoPath).toBe(normalizedLocalRepo);

    issues = diagnoseRepoBindings("platform");
    expect(issues).toEqual([]);
  });
});
