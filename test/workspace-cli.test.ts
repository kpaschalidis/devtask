import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../apps/cli/src/cli.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { registerWorkspace } from "../src/storage/global-index.js";

describe("workspace CLI", () => {
  const originalHome = process.env.DEVTASK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.DEVTASK_HOME;
    } else {
      process.env.DEVTASK_HOME = originalHome;
    }
    vi.restoreAllMocks();
  });

  it("prints a no-op message when no stale workspaces are registered", async () => {
    process.env.DEVTASK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });

    await createCli().parseAsync(["workspace", "prune"], { from: "user" });

    expect(logs).toEqual(["No stale workspaces found"]);
  });

  it("prints pruned stale workspace registrations", async () => {
    process.env.DEVTASK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const staleWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-cli-stale-"));
    const stalePaths = resolveWorkspacePathsForInit(staleWorkspace);
    initializeWorkspace(stalePaths);
    registerWorkspace(stalePaths, "stale");
    fs.rmSync(staleWorkspace, { recursive: true, force: true });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });

    await createCli().parseAsync(["workspace", "prune"], { from: "user" });

    expect(logs[0]).toBe("Pruned 1 stale workspace registration");
    expect(logs[1]).toBe(`stale: ${fs.realpathSync(path.dirname(staleWorkspace))}/${path.basename(staleWorkspace)}`);
  });
});
