import { describe, expect, it } from "vitest";
import type { DevtaskConfig } from "../src/config.js";
import { DevtaskError } from "../src/errors.js";
import { resolvePaths, taskMetaPath } from "../src/paths.js";
import { recordStage } from "../src/stage-contracts.js";
import { assertCheckReady, assertCommitReady, assertPrReady, assertReviewReady, assertRunReady } from "../src/stage-policy.js";
import { createTask, getTask } from "../src/task-store.js";
import { writeTaskMeta } from "../src/meta.js";
import { runVerification } from "../src/verification.js";
import { makeTempRepo } from "./helpers.js";

const configWithChecks: DevtaskConfig = {
  schemaVersion: 1,
  codex: {
    model: null,
    fullAuto: true
  },
  runtime: {
    mode: "plain",
    backend: null
  },
  runtimeConfigured: true,
  verify: ["true"]
};

describe("stage policy", () => {
  it("blocks running unplanned tasks", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "run-policy");

    expect(() => assertRunReady(meta)).toThrow(DevtaskError);
  });

  it("blocks checking before implementation completes", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "check-policy");

    expect(() => assertCheckReady(paths, meta)).toThrow(DevtaskError);
  });

  it("blocks review before configured checks pass", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");
    recordStage(paths, meta.id, "run", { status: "passed" });

    expect(() => assertReviewReady(paths, meta, configWithChecks)).toThrow(DevtaskError);
  });

  it("allows review after configured checks pass", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");

    recordStage(paths, meta.id, "run", { status: "passed" });
    await runVerification(paths, meta, ["true"]);

    expect(() => assertReviewReady(paths, meta, configWithChecks)).not.toThrow();
  });

  it("allows review when no deterministic checks are configured", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");
    recordStage(paths, meta.id, "run", { status: "passed" });

    expect(() => assertReviewReady(paths, meta, { ...configWithChecks, verify: [] })).not.toThrow();
  });

  it("blocks commit before approval", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "commit-policy");

    expect(() => assertCommitReady(paths, meta)).toThrow(DevtaskError);
  });

  it("blocks PR creation before approval", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "pr-policy");

    expect(() => assertPrReady(meta)).toThrow(DevtaskError);
  });

  it("allows PR creation after approval", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "pr-policy");
    writeTaskMeta(taskMetaPath(paths, meta.id), {
      ...meta,
      status: "approved"
    });

    expect(() => assertPrReady(getTask(paths, meta.id))).not.toThrow();
  });
});
