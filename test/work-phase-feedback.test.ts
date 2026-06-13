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
      buildInteractiveStartCommand: vi.fn(() => ({
        command: "fake-agent-interactive-start",
        session: {
          provider: "codex",
          transportId: null,
          resumeContext: {
            providerSessionId: null,
            conversationId: null,
            resumeTarget: null,
            storageRoot: "/tmp/codex-home",
            transcriptPath: null
          },
          summary: null,
          summaryIsFallback: null
        }
      })),
      buildResumeCommand: () => "fake-agent-resume",
      buildInteractiveResumeCommand: vi.fn(() => "fake-agent-interactive-resume"),
      installCompletionHook: vi.fn(),
      hydrateSessionRef: vi.fn(async (session) => ({
        ...session,
        resumeContext: {
          ...session.resumeContext,
          providerSessionId: session.resumeContext?.providerSessionId ?? "agent-123",
          conversationId: session.resumeContext?.conversationId ?? "thread-123",
          resumeTarget: session.resumeContext?.resumeTarget ?? "agent-123",
          transcriptPath: session.resumeContext?.transcriptPath ?? "/tmp/codex-home/sessions/spec.jsonl"
        },
        summary: "hydrated session",
        summaryIsFallback: false
      }))
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
  attachTmuxSession: vi.fn(),
  createBareSession: vi.fn(),
  killTmuxSession: vi.fn(),
  sendLaunchCommand: vi.fn(),
  startPipePane: vi.fn(async () => {}),
  startTmuxSession: vi.fn(),
  tmuxSessionExists: vi.fn(() => false),
  tmuxSessionName: vi.fn((_paths, taskId: string) => `devtask-test-${taskId}`),
  waitForTmuxSession: vi.fn(() => true),
  writeLaunchScript: vi.fn(() => "/tmp/devtask-launch.sh")
}));

import { resolveWorkspacePathsForInit, workItemSpecPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { getLatestWorkPhaseRun } from "../src/services/phase-run-service.js";
import { readScopedPhaseSession, updateScopedPhaseSession, writeRunningScopedPhaseSession } from "../src/services/phase-session-service.js";
import { attachWorkPhase, runManagedPhaseHookFinalizer, sendWorkPhaseFeedback, startSpecWork } from "../src/services/work-service.js";

const agent = await import("../src/agent.js");
const tmux = await import("../src/infra/tmux.js");

describe("work phase feedback", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(false);
    vi.mocked(tmux.waitForTmuxSession).mockReturnValue(true);
    vi.mocked(tmux.writeLaunchScript).mockReturnValue("/tmp/devtask-launch.sh");
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
        resumeContext: {
          providerSessionId: "agent-123",
          conversationId: "thread-123",
          resumeTarget: "agent-123",
          storageRoot: null,
          transcriptPath: null
        },
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

  it("resumes and attaches when the latest spec session is finished without managed completion tracking", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-attach-resume-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Resume finished spec session"
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
        resumeContext: {
          providerSessionId: "agent-123",
          conversationId: "thread-123",
          resumeTarget: "agent-123",
          storageRoot: "/tmp/codex-home",
          transcriptPath: "/tmp/codex-home/sessions/spec.jsonl"
        },
        summary: "spec complete",
        summaryIsFallback: false
      }
    });
    updateScopedPhaseSession(paths, item.id, "spec", null, {
      status: "completed",
      updatedAt: "2026-01-01T00:01:00.000Z"
    });
    vi.mocked(tmux.tmuxSessionExists).mockImplementation((session) => session === "devtask-test-spec-WORK-123");

    await attachWorkPhase(paths, "spec", item.id);

    expect(tmux.startTmuxSession).toHaveBeenCalledTimes(1);
    expect(tmux.attachTmuxSession).toHaveBeenCalledWith("devtask-test-spec-WORK-123");
    expect(readScopedPhaseSession(paths, item.id, "spec")?.status).toBe("running");
    const runner = vi.mocked(agent.createDefaultAgentRunner).mock.results.at(-1)?.value;
    expect(runner?.buildInteractiveResumeCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        managedCompletionCommand: null
      })
    );
  });

  it("starts fresh spec work as an interactive background session with a managed completion hook", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-fresh-interactive-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Interactive fresh spec"
    });
    fs.writeFileSync(item.source.artifact, "# Source\n");
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nFresh interactive spec.\n");

    const launch = await startSpecWork(paths, item.id);

    expect(launch.tmuxSession).toBe("devtask-test-spec-WORK-123");
    expect(tmux.startTmuxSession).toHaveBeenCalledTimes(1);
    expect(tmux.startPipePane).toHaveBeenCalledWith("devtask-test-spec-WORK-123", launch.outputPath);
    expect(readScopedPhaseSession(paths, item.id, "spec")?.status).toBe("running");
    const runner = vi.mocked(agent.createDefaultAgentRunner).mock.results.at(-1)?.value;
    expect(runner?.buildInteractiveStartCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        managedCompletionCommand: expect.stringContaining("work _phase-finalize-hook spec WORK-123")
      }),
      expect.any(String)
    );
  });

  it("finalizes the matching managed phase run from the hook callback and closes tmux", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-hook-finalize-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Hook finalize spec"
    });
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nFresh interactive spec updated.\n");
    writeRunningScopedPhaseSession(paths, {
      phase: "spec",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-2",
      tmuxSession: "devtask-test-spec-WORK-123",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: path.join(paths.localDir, "hook.prompt.md"),
      outputPath: path.join(paths.localDir, "hook.output.md"),
      artifacts: {
        specPath: workItemSpecPath(paths, item.id)
      },
      session: {
        provider: "codex",
        transportId: "devtask-test-spec-WORK-123",
        resumeContext: {
          providerSessionId: null,
          conversationId: null,
          resumeTarget: null,
          storageRoot: "/tmp/codex-home",
          transcriptPath: null
        },
        summary: null,
        summaryIsFallback: null
      }
    });
    vi.mocked(tmux.tmuxSessionExists).mockReturnValue(true);

    await runManagedPhaseHookFinalizer(paths, "spec", item.id, "run-2", null);

    expect(getLatestWorkPhaseRun(paths, item.id, "spec")?.status).toBe("spec-ready");
    expect(readScopedPhaseSession(paths, item.id, "spec")?.status).toBe("completed");
    expect(readScopedPhaseSession(paths, item.id, "spec")?.session.resumeContext.providerSessionId).toBe("agent-123");
    expect(tmux.killTmuxSession).toHaveBeenCalledWith("devtask-test-spec-WORK-123");
  });

  it("ignores stale hook callbacks for older managed runs", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-hook-stale-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Ignore stale hook"
    });
    fs.writeFileSync(workItemSpecPath(paths, item.id), "# Spec\n\nOriginal.\n");
    writeRunningScopedPhaseSession(paths, {
      phase: "spec",
      workId: item.id,
      repoId: null,
      taskId: null,
      runId: "run-current",
      tmuxSession: "devtask-test-spec-WORK-123",
      startedAt: "2026-01-01T00:00:00.000Z",
      promptPath: path.join(paths.localDir, "current.prompt.md"),
      outputPath: path.join(paths.localDir, "current.output.md"),
      artifacts: {
        specPath: workItemSpecPath(paths, item.id)
      },
      session: {
        provider: "codex",
        transportId: "devtask-test-spec-WORK-123",
        resumeContext: {
          providerSessionId: null,
          conversationId: null,
          resumeTarget: null,
          storageRoot: "/tmp/codex-home",
          transcriptPath: null
        },
        summary: null,
        summaryIsFallback: null
      }
    });

    await runManagedPhaseHookFinalizer(paths, "spec", item.id, "run-old", null);

    expect(readScopedPhaseSession(paths, item.id, "spec")?.status).toBe("running");
    expect(getLatestWorkPhaseRun(paths, item.id, "spec")).toBeNull();
    expect(tmux.killTmuxSession).not.toHaveBeenCalled();
  });
});
