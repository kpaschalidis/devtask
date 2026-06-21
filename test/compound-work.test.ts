import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  return {
    ...actual,
    createDefaultAgentRunner: vi.fn(() => ({})),
    runAgentPrompt: vi.fn(async (_runner, _options, prompt: string, output: { outputPath: string }) => {
      const learningsPath = prompt.match(/learning report: (.+)/)?.[1];
      if (!learningsPath) throw new Error("missing learning report path");
      fs.writeFileSync(learningsPath, "# Learnings\n\n## Planning\n\n- none\n");
      fs.writeFileSync(output.outputPath, "compound complete\n");
      return {
        status: "completed",
        error: null,
        session: {
          provider: "codex",
          transportId: null,
          resumeContext: {
            providerSessionId: "agent-1",
            conversationId: "thread-1",
            resumeTarget: "agent-1",
            storageRoot: null,
            transcriptPath: null
          },
          summary: "compound complete",
          summaryIsFallback: false
        }
      };
    })
  };
});

import { workItemDir, workItemLearningsPath, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { getLatestWorkPhaseRun } from "../src/services/session-run-service.js";
import { compoundWork } from "../src/services/work-service.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";

const agent = await import("../src/agent.js");

describe("compound work", () => {
  it("exposes only the human-readable learning report as its output artifact", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-compound-work-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-1", title: "Compound work" });

    const result = await compoundWork(paths, item.id);

    const learningsPath = workItemLearningsPath(paths, item.id);
    expect(result).toMatchObject({
      workId: item.id,
      status: "completed",
      learningsPath
    });
    expect(getLatestWorkPhaseRun(paths, item.id, "compound", null)?.artifacts).toEqual({ learningsPath });
    expect(vi.mocked(agent.runAgentPrompt).mock.calls[0]?.[1].addDirs).toEqual([workItemDir(paths, item.id)]);
  });
});
