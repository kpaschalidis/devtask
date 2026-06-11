import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/infra/tmux.js", () => ({
  attachTmuxSession: vi.fn(),
  sendToTmuxSessionWithConfirmation: vi.fn(),
  tmuxSessionExists: vi.fn(() => false)
}));

import { resolveWorkspacePathsForInit, taskMetaPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan } from "../src/work-materializer.js";
import { workGraphPath } from "../src/global-plan.js";
import { readTaskMeta, writeTaskMeta } from "../src/storage/meta.js";
import { getSession, listSessions } from "../src/services/session-service.js";
import { makeTempRepo } from "./helpers.js";

const tmux = await import("../src/infra/tmux.js");

describe("session service", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(false);
  });

  it("surfaces persisted task runtime visibility for work sessions", async () => {
    const { paths } = await createMaterializedWork();
    const metaPath = taskMetaPath(paths, "work-123-backend");
    const initial = readTaskMeta(metaPath);
    writeTaskMeta(metaPath, {
      ...initial,
      status: "paused",
      tmuxSession: "devtask-backend",
      agentThreadId: "thread-123",
      agentSessionId: "agent-123",
      resultSummary: "waiting for API contract",
      runtime: {
        state: "missing",
        reason: "recorded tmux session devtask-backend is not running",
        lastObservedAt: "2026-01-01T00:00:10.000Z"
      },
      updatedAt: "2026-01-01T00:00:11.000Z"
    });

    const [session] = await listSessions(paths, "WORK-123");

    expect(session).toMatchObject({
      repoId: "backend",
      taskId: "work-123-backend",
      taskStatus: "paused",
      sessionStatus: "inactive",
      sessionName: "devtask-backend",
      runtimeState: "missing",
      runtimeReason: "recorded tmux session devtask-backend is not running",
      lastActivityAt: "2026-01-01T00:00:10.000Z",
      resultSummary: "waiting for API contract",
      threadId: "thread-123",
      agentSessionId: "agent-123"
    });
  });

  it("marks live sessions as active while preserving task status", async () => {
    const { paths } = await createMaterializedWork();
    const metaPath = taskMetaPath(paths, "work-123-backend");
    const initial = readTaskMeta(metaPath);
    writeTaskMeta(metaPath, {
      ...initial,
      status: "running",
      tmuxSession: "live-session",
      runtime: {
        state: "alive",
        reason: "execution session is active",
        lastObservedAt: "2026-01-01T00:00:12.000Z"
      },
      updatedAt: "2026-01-01T00:00:13.000Z"
    });
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((name) => name === "live-session");

    const session = await getSession(paths, "WORK-123", "backend");

    expect(session.taskStatus).toBe("running");
    expect(session.sessionStatus).toBe("active");
    expect(session.runtimeReason).toBe("execution session is active");
    expect(session.lastActivityAt).toBe("2026-01-01T00:00:12.000Z");
  });
});

async function createMaterializedWork(): Promise<{ paths: ReturnType<typeof resolveWorkspacePathsForInit> }> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-session-service-"));
  const repo = await makeTempRepo({ withCommit: true });
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  const item = createManualWorkItem(paths, {
    id: "WORK-123",
    title: "Add API behavior"
  });
  addWorkspaceRepo(paths, {
    id: "backend",
    repoPath: repo,
    kind: "api"
  });
  fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
  fs.writeFileSync(
    workGraphPath(paths, item.id),
    JSON.stringify(
      {
        schemaVersion: 1,
        workId: item.id,
        tasks: [
          {
            id: "work-123-backend",
            repoId: "backend",
            goal: "Implement backend behavior.",
            owns: ["server/**"],
            dependencies: []
          }
        ],
        validation: [],
        openQuestions: []
      },
      null,
      2
    )
  );
  await materializeWorkPlan(paths, item);
  return { paths };
}
