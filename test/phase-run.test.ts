import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLatestPhaseRunRecord, writePhaseRunRecord } from "../src/infra/phase-run.js";

describe("phase run records", () => {
  it("writes and reads the latest persisted phase run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-phase-run-"));

    writePhaseRunRecord(dir, {
      schemaVersion: 1,
      phase: "spec",
      runId: "2026-01-01T00-00-00-000Z",
      workId: "WORK-1",
      repoId: null,
      taskId: null,
      status: "spec-ready",
      promptPath: "/tmp/spec.prompt.md",
      outputPath: "/tmp/spec.output.md",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      session: {
        transportSessionId: "tmux-1",
        threadId: "thread-1",
        agentSessionId: "agent-1",
        summary: "completed",
        summaryIsFallback: false
      },
      artifacts: {
        specPath: "/tmp/spec.md"
      },
      exitCode: 0
    });
    writePhaseRunRecord(dir, {
      schemaVersion: 1,
      phase: "spec",
      runId: "2026-01-01T00-00-01-000Z",
      workId: "WORK-1",
      repoId: null,
      taskId: null,
      status: "failed",
      promptPath: "/tmp/spec-2.prompt.md",
      outputPath: "/tmp/spec-2.output.md",
      startedAt: "2026-01-01T00:00:03.000Z",
      finishedAt: "2026-01-01T00:00:04.000Z",
      session: {
        transportSessionId: "tmux-2",
        threadId: null,
        agentSessionId: null,
        summary: null,
        summaryIsFallback: null
      },
      artifacts: {
        specPath: "/tmp/spec-2.md"
      },
      exitCode: null
    });

    expect(readLatestPhaseRunRecord(dir)?.runId).toBe("2026-01-01T00-00-01-000Z");
    expect(readLatestPhaseRunRecord(dir)?.status).toBe("failed");
  });
});
