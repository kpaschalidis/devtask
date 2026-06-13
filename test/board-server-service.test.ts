import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem, updateWorkItemStatus } from "../src/storage/work-store.js";
import { registerWorkspace } from "../src/storage/global-index.js";
import { startBoardServer } from "../src/board/server.js";

describe("board server service", () => {
  const originalHome = process.env.DEVTASK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.DEVTASK_HOME;
    } else {
      process.env.DEVTASK_HOME = originalHome;
    }
  });

  it("serves live workspace HTML and updated JSON data", async () => {
    process.env.DEVTASK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-home-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-board-serve-"));
    const paths = resolveWorkspacePathsForInit(workspaceRoot);
    initializeWorkspace(paths);
    registerWorkspace(paths, "platform");
    createManualWorkItem(paths, { id: "APP-123", title: "Initial title" });

    const server = await startBoardServer({ workspaceId: "platform" });
    try {
      const html = await fetch(`${server.url}/workspaces/platform`).then((response) => response.text());
      expect(html).toContain("data-refresh-button");
      expect(html).toContain("Initial title");

      updateWorkItemStatus(paths, "APP-123", "blocked");

      const json = await fetch(`${server.url}/api/workspaces/platform`).then((response) => response.json()) as {
        rows: Array<{ status: string }>;
      };
      expect(json.rows[0]?.status).toBe("blocked");
    } finally {
      await server.close();
    }
  });
});
