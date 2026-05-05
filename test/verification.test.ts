import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.js";
import { createTask } from "../src/task-store.js";
import { readLatestVerification, runVerification } from "../src/verification.js";
import { makeTempRepo } from "./helpers.js";

describe("verification", () => {
  it("records passing verification steps", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "verify-pass");

    const record = await runVerification(paths, meta, ["node -e \"process.exit(0)\""]);

    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(1);
    expect(readLatestVerification(paths, meta.id)?.status).toBe("passed");
  });

  it("stops after the first failing verification step", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "verify-fail");

    const record = await runVerification(paths, meta, [
      "node -e \"console.error('failed'); process.exit(4)\"",
      "node -e \"process.exit(0)\""
    ]);

    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0]?.exitCode).toBe(4);
    expect(record.steps[0]?.stderr).toContain("failed");
  });
});
