import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, writeConfig } from "../src/infra/config.js";
import { phaseRunDir, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { runCommandOrThrow } from "../src/infra/process-runner.js";
import { readTaskMeta, writeTaskMeta } from "../src/storage/meta.js";
import { createTask, initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem, getWorkItem } from "../src/storage/work-store.js";
import { makeTempRepo } from "./helpers.js";

const scmMocks = vi.hoisted(() => ({
  checkProviderCi: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  pushBranchUpdate: vi.fn()
}));

const agentMocks = vi.hoisted(() => ({
  createDefaultAgentRunner: vi.fn(() => ({ provider: "mock" })),
  runAgentPrompt: vi.fn()
}));

vi.mock("../src/adapters/scm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/adapters/scm/index.js")>("../src/adapters/scm/index.js");
  return {
    ...actual,
    checkProviderCi: scmMocks.checkProviderCi,
    hasUncommittedChanges: scmMocks.hasUncommittedChanges,
    pushBranchUpdate: scmMocks.pushBranchUpdate
  };
});

vi.mock("../src/agent.js", () => ({
  createDefaultAgentRunner: agentMocks.createDefaultAgentRunner,
  runAgentPrompt: agentMocks.runAgentPrompt
}));

import { watchWorkCi } from "../src/services/work-service.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("work ci-watch", () => {
  it("records failure context, runs a scoped fix attempt, validates, and completes after CI passes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-ci-watch-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-123", title: "Fix flaky CI" });
    const task = await createTask(paths, "work-123-app", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "app", "work-123-app")
    });
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");
    writeMaterialization(paths, item.id, repo, task.id, task.branch, task.worktreePath);
    const metaPath = path.join(paths.tasksDir, task.id, "meta.json");
    writeTaskMeta(metaPath, {
      ...readTaskMeta(metaPath),
      status: "done",
      prUrl: "https://github.com/acme/app/pull/123",
      updatedAt: new Date().toISOString()
    });
    writeConfig(paths, DEFAULT_CONFIG);

    scmMocks.checkProviderCi
      .mockResolvedValueOnce({
        provider: "github",
        status: "failed",
        detail: "test suite failed",
        url: "https://github.com/acme/app/pull/123",
        failureOutput: "FAIL src/example.test.ts"
      })
      .mockResolvedValueOnce({
        provider: "github",
        status: "passed",
        detail: "all checks passed",
        url: "https://github.com/acme/app/pull/123",
        failureOutput: null
      });
    scmMocks.hasUncommittedChanges.mockResolvedValue(false);
    scmMocks.pushBranchUpdate.mockResolvedValue(undefined);
    agentMocks.runAgentPrompt.mockImplementation(async (_runner, startOptions: { workspacePath: string; env?: Record<string, string> }) => {
      fs.writeFileSync(path.join(startOptions.workspacePath, "ci-fix.txt"), "fixed\n");
      await runCommandOrThrow("git", ["add", "ci-fix.txt"], { cwd: startOptions.workspacePath });
      await runCommandOrThrow("git", ["commit", "-m", "fix ci failure"], { cwd: startOptions.workspacePath });
      fs.writeFileSync(startOptions.env!.DEVTASK_RESULT_PATH!, "{\n  \"status\": \"done\"\n}\n");
      return {
        status: "completed",
        error: null,
        session: {
          provider: "codex",
          transportId: "ci-fix-run",
          resumeContext: {
            providerSessionId: null,
            conversationId: null,
            resumeTarget: null,
            storageRoot: null,
            transcriptPath: null
          },
          summary: "fixed ci",
          summaryIsFallback: false
        }
      };
    });

    const result = await watchWorkCi(paths, item.id, { pollIntervalMs: 0, maxPolls: 1 });

    expect(result.status).toBe("completed");
    expect(result.tasks[0]).toMatchObject({
      repoId: "app",
      status: "passed",
      attempts: 1,
      lastCiStatus: "passed"
    });
    expect(result.tasks[0]?.fixRuns[0]?.status).toBe("completed");
    expect(result.tasks[0]?.latestFailureLogPath).toBeTruthy();
    expect(fs.readFileSync(result.tasks[0]!.latestFailureLogPath!, "utf8")).toContain("FAIL src/example.test.ts");
    expect(scmMocks.pushBranchUpdate).toHaveBeenCalledWith(task.worktreePath, task.branch);
    expect(getWorkItem(paths, item.id).status).toBe("completed");
    expect(fs.existsSync(path.join(phaseRunDir(paths, item.id, "ci-fix", "app")))).toBe(true);
  });

  it("marks the work item blocked when the configured max CI fix attempts is reached", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-ci-watch-max-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-999", title: "Stop failing CI" });
    const task = await createTask(paths, "work-999-app", {
      repoRoot: repo,
      worktreePath: path.join(paths.worktreesDir, "app", "work-999-app")
    });
    fs.writeFileSync(path.join(paths.tasksDir, task.id, "plan.md"), "# Repo Plan\n");
    writeMaterialization(paths, item.id, repo, task.id, task.branch, task.worktreePath);
    const metaPath = path.join(paths.tasksDir, task.id, "meta.json");
    writeTaskMeta(metaPath, {
      ...readTaskMeta(metaPath),
      status: "done",
      prUrl: "https://github.com/acme/app/pull/999",
      updatedAt: new Date().toISOString()
    });
    writeConfig(paths, {
      ...DEFAULT_CONFIG,
      ci: {
        maxFixAttempts: 0
      }
    });

    scmMocks.checkProviderCi.mockResolvedValue({
      provider: "github",
      status: "failed",
      detail: "still failing",
      url: "https://github.com/acme/app/pull/999",
      failureOutput: "FAIL src/max.test.ts"
    });

    const result = await watchWorkCi(paths, item.id, { pollIntervalMs: 0, maxPolls: 1 });

    expect(result.status).toBe("blocked");
    expect(result.tasks[0]).toMatchObject({
      repoId: "app",
      status: "max-attempts",
      attempts: 0
    });
    expect(agentMocks.runAgentPrompt).not.toHaveBeenCalled();
    expect(getWorkItem(paths, item.id).status).toBe("blocked");
  });
});

function writeMaterialization(
  paths: ReturnType<typeof resolveWorkspacePathsForInit>,
  workId: string,
  repoPath: string,
  taskId: string,
  branch: string,
  worktreePath: string
): void {
  const dir = path.join(paths.localDir, "work", workId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "materialization.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      workId,
      graphSnapshotPath: path.join(dir, "graph.snapshot.json"),
      materializedAt: new Date().toISOString(),
      tasks: [
        {
          graphTaskId: taskId,
          repoId: "app",
          repoPath,
          scope: null,
          taskId,
          branch,
          worktreePath
        }
      ]
    }, null, 2)}\n`
  );
}
