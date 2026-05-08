import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { readStageLedger, recordStage, runStage, stageLedgerPath } from "../src/stage-contracts.js";
import { resolvePaths, taskDir } from "../src/paths.js";
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

  it("starts new running attempts with fresh timestamps and no stale output", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "retry-task");

    recordStage(paths, meta.id, "check", {
      status: "failed",
      output: {
        verificationId: "old"
      },
      artifacts: ["/tmp/old.json"],
      reason: "old failure"
    });
    const retry = recordStage(paths, meta.id, "check", {
      status: "running",
      input: {
        commands: ["npm test"]
      }
    });

    expect(retry.status).toBe("running");
    expect(retry.finishedAt).toBeNull();
    expect(retry.output).toEqual({});
    expect(retry.artifacts).toEqual([]);
    expect(retry.reason).toBeNull();
  });

  it("records failed terminal state when runStage throws", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "throw-task");

    await expect(
      runStage(
        paths,
        meta.id,
        "pr",
        {
          input: {
            title: "throw-task"
          }
        },
        async () => {
          throw new Error("provider unavailable");
        }
      )
    ).rejects.toThrow("provider unavailable");

    expect(readStageLedger(paths, meta.id).stages.pr).toMatchObject({
      status: "failed",
      input: {
        title: "throw-task"
      },
      reason: "provider unavailable"
    });
  });

  it("quarantines corrupt stage ledgers instead of overwriting them", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "corrupt-task");
    fs.mkdirSync(taskDir(paths, meta.id), { recursive: true });
    fs.writeFileSync(stageLedgerPath(paths, meta.id), "{not json");

    expect(() => readStageLedger(paths, meta.id)).toThrow("Stage ledger for task corrupt-task is corrupt");
    expect(fs.existsSync(stageLedgerPath(paths, meta.id))).toBe(false);
    expect(fs.readdirSync(taskDir(paths, meta.id)).some((file) => file.startsWith("stages.json.corrupt."))).toBe(true);
  });
});
