import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevtaskError } from "../src/infra/errors.js";
import { resolveWorkspacePathsForInit, workItemPrWatchStatePath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { writePrWatchState } from "../src/storage/pr-watch-state.js";
import { extractDevTaskInstruction, runPrWatchIteration, watchWorkPullRequests } from "../src/services/pr-watch-service.js";

describe("pr watch service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts /devtask instructions case-insensitively", () => {
    expect(extractDevTaskInstruction("/devtask rerun the check")).toBe("rerun the check");
    expect(extractDevTaskInstruction("   /DEVTASK   update the plan  ")).toBe("update the plan");
    expect(extractDevTaskInstruction("please review")).toBeNull();
    expect(extractDevTaskInstruction("/devtask   ")).toBeNull();
  });

  it("routes matching comments to a live orchestrator session and persists processed ids", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-pr-watch-live-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, { id: "WORK-123", title: "PR watch" });
    const statePath = workItemPrWatchStatePath(paths, "WORK-123");
    const sendToTmuxSession = vi.fn();
    const sendFeedback = vi.fn();

    const result = await runPrWatchIteration(
      paths,
      "WORK-123",
      statePath,
      [{ repoId: "app", worktreePath: "/tmp/repo" }],
      {
        listPullRequests: vi.fn(async () => [
          { id: "1", number: "1", title: "WORK-123: improve flow", branch: "task/work-123", url: null },
          { id: "2", number: "2", title: "Other item", branch: "task/other", url: null }
        ]),
        listPullRequestComments: vi.fn(async () => [
          { id: "c-1", body: "/devtask continue with the review", author: "reviewer", createdAt: null, url: null },
          { id: "c-2", body: "plain comment", author: "reviewer", createdAt: null, url: null }
        ]),
        sendToTmuxSession,
        sendFeedback,
        readNow: () => ({ tmuxSession: "devtask-live", live: true }),
        sleep: async () => undefined
      }
    );

    expect(result).toEqual({ pickedUpCount: 1 });
    expect(sendToTmuxSession).toHaveBeenCalledWith("devtask-live", "continue with the review");
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      processedCommentIds: ["c-1"]
    });
  });

  it("falls back to persisted orchestrator feedback when no live tmux session exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-pr-watch-fallback-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, { id: "WORK-123", title: "PR watch" });
    const statePath = workItemPrWatchStatePath(paths, "WORK-123");
    const sendFeedback = vi.fn(async () => undefined);

    await runPrWatchIteration(
      paths,
      "WORK-123",
      statePath,
      [{ repoId: "app", worktreePath: "/tmp/repo" }],
      {
        listPullRequests: vi.fn(async () => [
          { id: "1", number: "1", title: "Fix for work-123", branch: "task/work-123", url: null }
        ]),
        listPullRequestComments: vi.fn(async () => [
          { id: "c-1", body: "/devtask update spec", author: "reviewer", createdAt: null, url: null }
        ]),
        sendToTmuxSession: vi.fn(),
        sendFeedback,
        readNow: () => ({ tmuxSession: null, live: false }),
        sleep: async () => undefined
      }
    );

    expect(sendFeedback).toHaveBeenCalledWith(paths, "WORK-123", "update spec");
  });

  it("does not reprocess comment ids already stored in the local state file", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-pr-watch-idempotent-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, { id: "WORK-123", title: "PR watch" });
    const statePath = workItemPrWatchStatePath(paths, "WORK-123");
    writePrWatchState(statePath, { processedCommentIds: ["c-1"] });
    const sendToTmuxSession = vi.fn();

    const result = await runPrWatchIteration(
      paths,
      "WORK-123",
      statePath,
      [{ repoId: "app", worktreePath: "/tmp/repo" }],
      {
        listPullRequests: vi.fn(async () => [
          { id: "1", number: "1", title: "WORK-123", branch: "task/work-123", url: null }
        ]),
        listPullRequestComments: vi.fn(async () => [
          { id: "c-1", body: "/devtask already seen", author: "reviewer", createdAt: null, url: null }
        ]),
        sendToTmuxSession,
        sendFeedback: vi.fn(async () => undefined),
        readNow: () => ({ tmuxSession: "devtask-live", live: true }),
        sleep: async () => undefined
      }
    );

    expect(result).toEqual({ pickedUpCount: 0 });
    expect(sendToTmuxSession).not.toHaveBeenCalled();
  });

  it("warns at startup when no orchestrator session is live yet and still polls", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-pr-watch-warning-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-123", title: "PR watch" });
    fs.mkdirSync(path.dirname(workItemPrWatchStatePath(paths, item.id)), { recursive: true });
    fs.writeFileSync(
      path.join(paths.localDir, "work", item.id, "materialization.json"),
      JSON.stringify({
        schemaVersion: 1,
        workId: item.id,
        graphSnapshotPath: "/tmp/graph.json",
        materializedAt: "2026-01-01T00:00:00.000Z",
        tasks: [
          {
            graphTaskId: "task-1",
            repoId: "app",
            repoPath: "/tmp/repo",
            scope: null,
            taskId: "task-1",
            branch: "task/work-123",
            worktreePath: "/tmp/repo"
          }
        ]
      }, null, 2)
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listPullRequests = vi.fn(async () => []);

    await watchWorkPullRequests(paths, item.id, { maxPolls: 1, intervalMs: 1 }, {
      listPullRequests,
      listPullRequestComments: vi.fn(async () => []),
      sendToTmuxSession: vi.fn(),
      sendFeedback: vi.fn(async () => undefined),
      readNow: () => ({ tmuxSession: null, live: false }),
      sleep: async () => undefined
    });

    expect(warn).toHaveBeenCalledWith(
      "Warning: no running orchestrator session found for WORK-123; continuing to poll for future feedback routing."
    );
    expect(listPullRequests).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the existing pr-watch state file is malformed", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-pr-watch-invalid-state-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    createManualWorkItem(paths, { id: "WORK-123", title: "PR watch" });
    const statePath = workItemPrWatchStatePath(paths, "WORK-123");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{\"processedCommentIds\":[1]}\n");

    await expect(
      runPrWatchIteration(
        paths,
        "WORK-123",
        statePath,
        [{ repoId: "app", worktreePath: "/tmp/repo" }],
        {
          listPullRequests: vi.fn(async () => []),
          listPullRequestComments: vi.fn(async () => []),
          sendToTmuxSession: vi.fn(),
          sendFeedback: vi.fn(async () => undefined),
          readNow: () => ({ tmuxSession: null, live: false }),
          sleep: async () => undefined
        }
      )
    ).rejects.toThrow(DevtaskError);
  });
});
