import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/agent-kernel/tmux-control.js", () => ({
  tmuxSessionExists: vi.fn(() => false)
}));

import { resolveWorkspacePathsForInit, phaseRunDir, workItemReviewDir } from "../src/infra/paths.js";
import { writeRunningPhaseRun } from "../src/infra/session-run.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { writeGateState } from "../src/mission/gates.js";
import { getWorkStatus } from "../src/services/work-status-service.js";

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-status-"));
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  return paths;
}

describe("getWorkStatus", () => {
  it("returns nulls when no session or gates exist", () => {
    const paths = makeWorkspace();
    const status = getWorkStatus(paths, "WORK-1");

    expect(status.workId).toBe("WORK-1");
    expect(status.orchestratorSession.running).toBe(false);
    expect(status.orchestratorSession.tmuxSession).toBeNull();
    expect(status.gate1).toBeNull();
    expect(status.gate2).toBeNull();
    expect(status.validatorResults).toHaveLength(0);
  });

  it("reflects gate states when written", () => {
    const paths = makeWorkspace();
    writeGateState(paths, "WORK-1", "gate-1", { status: "approved", message: "looks good" });

    const status = getWorkStatus(paths, "WORK-1");
    expect(status.gate1?.status).toBe("approved");
    expect(status.gate1?.message).toBe("looks good");
    expect(status.gate2).toBeNull();
  });

  it("reflects a stopped orchestrator session (tmux gone)", () => {
    const paths = makeWorkspace();
    const runsDir = phaseRunDir(paths, "WORK-1", "orchestrate", null);
    fs.mkdirSync(runsDir, { recursive: true });
    writeRunningPhaseRun(runsDir, {
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      phase: "orchestrate",
      repoId: null,
      taskId: null,
      tmuxSession: "devtask-orch-1",
      promptPath: "/tmp/prompt.md",
      outputPath: "/tmp/output.md",
      artifacts: {},
      session: {
        provider: "codex",
        transportId: "tmux-1",
        resumeContext: { providerSessionId: null, conversationId: null, resumeTarget: null, storageRoot: null, transcriptPath: null },
        summary: null,
        summaryIsFallback: false
      },
      startedAt: new Date().toISOString()
    });

    const status = getWorkStatus(paths, "WORK-1");
    expect(status.orchestratorSession.tmuxSession).toBe("devtask-orch-1");
    expect(status.orchestratorSession.running).toBe(false); // tmux mock returns false
  });

  it("parses validator results from review dir", () => {
    const paths = makeWorkspace();
    const reviewDir = workItemReviewDir(paths, "WORK-1");
    fs.mkdirSync(reviewDir, { recursive: true });

    fs.writeFileSync(
      path.join(reviewDir, "backend.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "failed",
        assertions: [
          { id: "VAL-001", status: "passed", evidence: "src/foo.ts:12" },
          { id: "VAL-002", status: "failed", evidence: "function missing" }
        ],
        commands: []
      })
    );

    fs.writeFileSync(
      path.join(reviewDir, "frontend.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "passed",
        assertions: [{ id: "VAL-003", status: "passed", evidence: "test passed" }],
        commands: []
      })
    );

    const status = getWorkStatus(paths, "WORK-1");
    expect(status.validatorResults).toHaveLength(2);

    const backend = status.validatorResults.find((r) => r.repoId === "backend");
    expect(backend?.status).toBe("failed");
    expect(backend?.totalAssertions).toBe(2);
    expect(backend?.failedAssertions).toBe(1);

    const frontend = status.validatorResults.find((r) => r.repoId === "frontend");
    expect(frontend?.status).toBe("passed");
    expect(frontend?.totalAssertions).toBe(1);
    expect(frontend?.failedAssertions).toBe(0);
  });

  it("handles malformed validator result gracefully", () => {
    const paths = makeWorkspace();
    const reviewDir = workItemReviewDir(paths, "WORK-1");
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, "backend.json"), "not json{{{");

    const status = getWorkStatus(paths, "WORK-1");
    expect(status.validatorResults).toHaveLength(1);
    expect(status.validatorResults[0]?.status).toBe("unknown");
  });
});
