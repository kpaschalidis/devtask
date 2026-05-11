import { describe, expect, it } from "vitest";
import type { DevtaskConfig } from "../src/config.js";
import { DevtaskError } from "../src/errors.js";
import { resolvePaths } from "../src/paths.js";
import { assertReviewReady } from "../src/stage-policy.js";
import { createTask } from "../src/task-store.js";
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
  it("blocks review before configured checks pass", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");

    expect(() => assertReviewReady(paths, meta, configWithChecks)).toThrow(DevtaskError);
  });

  it("allows review after configured checks pass", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");

    await runVerification(paths, meta, ["true"]);

    expect(() => assertReviewReady(paths, meta, configWithChecks)).not.toThrow();
  });

  it("allows review when no deterministic checks are configured", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "review-policy");

    expect(() => assertReviewReady(paths, meta, { ...configWithChecks, verify: [] })).not.toThrow();
  });
});
