import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  return {
    ...actual,
    createDefaultAgentRunner: vi.fn(() => ({
      buildStartCommand: () => "fake-agent-start",
      buildResumeCommand: () => "fake-agent-resume"
    })),
    runAgentPrompt: vi.fn(),
    resumeAgentPrompt: vi.fn(async (_runner, session, resumeOptions: { workspacePath: string }, _prompt: string, options: { outputPath: string }) => {
      const specPath = path.join(resumeOptions.workspacePath, ".devtask", "work", "WORK-123", "spec.md");
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, "# Spec\n\nUpdated from feedback.\n");
      fs.writeFileSync(options.outputPath, "resumed\n");
      return {
        status: "completed",
        error: null,
        session: {
          ...session,
          summary: "spec updated from feedback",
          summaryIsFallback: false
        }
      };
    })
  };
});

vi.mock("../src/infra/tmux.js", () => ({
  createBareSession: vi.fn(),
  sendLaunchCommand: vi.fn(),
  startTmuxSession: vi.fn(),
  tmuxSessionExists: vi.fn(() => false),
  tmuxSessionName: vi.fn((_paths, taskId: string) => `devtask-test-${taskId}`),
  waitForTmuxSession: vi.fn(() => true),
  writeLaunchScript: vi.fn(() => "/tmp/devtask-launch.sh")
}));

import { resolveWorkspacePathsForInit, workItemSpecPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { readScopedPhaseSession, updateScopedPhaseSession, writeRunningScopedPhaseSession } from "../src/services/phase-session-service.js";
import { getLatestWorkPhaseRun } from "../src/services/phase-run-service.js";
import { runSpecFeedbackWorker, sendWorkPhaseFeedback } from "../src/services/work-service.js";

const agent = await import("../src/agent.js");
const tmux = await import("../src/infra/tmux.js");

describe("work phase feedback", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(false);
    vi.mocked(tmux.waitForTmuxSession).mockReturnValue(true);
    vi.mocked(tmux.writeLaunchScript).mockReturnValue("/tmp/devtask-launch.sh");
  });

  it("resumes spec feedback through the agent abstraction and records a new phase run", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-feedback-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Update spec from feedback"
    });
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nOriginal.\n");

    writeRunningScopedPhaseSession(paths, {
      phase: "spec",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-1",
      tmuxSession: "old-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: path.join(paths.localDir, "old.prompt.md"),
      outputPath: path.join(paths.localDir, "old.output.md"),
      artifacts: {
        specPath: workItemSpecPath(paths, item.id)
      },
      session: {
        provider: "codex",
        transportId: "old-session",
        providerSessionId: "agent-123",
        conversationId: "thread-123",
        resumeTarget: "agent-123",
        storageRoot: "/tmp/codex-home",
        transcriptPath: "/tmp/codex-home/sessions/spec.jsonl",
        summary: "spec complete",
        summaryIsFallback: false
      }
    });
    updateScopedPhaseSession(paths, item.id, "spec", null, {
      status: "completed",
      updatedAt: "2026-01-01T00:01:00.000Z"
    });

    const launch = await sendWorkPhaseFeedback(paths, "spec", item.id, "Narrow scope to local registry cleanup only.");

    expect(launch.tmuxSession).toBe("devtask-test-spec-WORK-123");
    expect(tmux.startTmuxSession).toHaveBeenCalled();

    await runSpecFeedbackWorker(paths, item.id);

    expect(agent.resumeAgentPrompt).toHaveBeenCalledTimes(1);
    expect(agent.runAgentPrompt).not.toHaveBeenCalled();
    expect(fs.readFileSync(readScopedPhaseSession(paths, item.id, "spec")!.promptPath, "utf8")).toContain("Narrow scope to local registry cleanup only.");
    expect(getLatestWorkPhaseRun(paths, item.id, "spec")?.status).toBe("spec-ready");
    expect(readScopedPhaseSession(paths, item.id, "spec")?.live).toBe(false);
  });

  it("does not treat completed sessions as live when tmux still exists", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-feedback-live-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Completed session visibility"
    });

    writeRunningScopedPhaseSession(paths, {
      phase: "spec",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-1",
      tmuxSession: "still-there",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: "/tmp/spec.prompt.md",
      outputPath: "/tmp/spec.output.md",
      artifacts: {
        specPath: workItemSpecPath(paths, item.id)
      },
      session: {
        provider: "codex",
        transportId: "still-there",
        providerSessionId: "agent-123",
        conversationId: "thread-123",
        resumeTarget: "agent-123",
        storageRoot: null,
        transcriptPath: null,
        summary: "done",
        summaryIsFallback: false
      }
    });
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(true);
    updateScopedPhaseSession(paths, item.id, "spec", null, {
      status: "completed",
      updatedAt: "2026-01-01T00:01:00.000Z"
    });

    expect(readScopedPhaseSession(paths, item.id, "spec")?.live).toBe(false);
  });
});
