import { describe, expect, it } from "vitest";
import { readStageLedger, recordStage } from "../src/stage-contracts.js";
import { resolvePaths } from "../src/paths.js";
import { createTask } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("stage contracts", () => {
  it("records the latest stage status with input, output, and artifacts", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "contract-task");

    recordStage(paths, meta.id, "check", {
      status: "running",
      input: {
        commands: ["npm test"]
      }
    });
    recordStage(paths, meta.id, "check", {
      status: "passed",
      output: {
        verificationId: "verify-1"
      },
      artifacts: ["/tmp/verify-1.json"]
    });

    const ledger = readStageLedger(paths, meta.id);

    expect(ledger.taskId).toBe(meta.id);
    expect(ledger.stages.check).toMatchObject({
      stage: "check",
      status: "passed",
      input: {
        commands: ["npm test"]
      },
      output: {
        verificationId: "verify-1"
      },
      artifacts: ["/tmp/verify-1.json"]
    });
  });
});
