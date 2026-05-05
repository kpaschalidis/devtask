import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.js";
import { readLatestReviewAgent } from "../src/review-agent.js";
import { createTask } from "../src/task-store.js";
import { makeTempRepo } from "./helpers.js";

describe("review-agent records", () => {
  it("reads the latest review-agent record", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "reviewed");
    const reviewsDir = path.join(repo, ".devtask", "tasks", meta.id, "reviews");
    fs.mkdirSync(reviewsDir, { recursive: true });

    const record = {
      schemaVersion: 1,
      reviewId: "2026-01-01T00-00-00-000Z",
      taskId: meta.id,
      status: "passed",
      command: "true",
      outputPath: path.join(reviewsDir, "2026-01-01T00-00-00-000Z.md"),
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0
    };
    fs.writeFileSync(path.join(reviewsDir, `${record.reviewId}.json`), `${JSON.stringify(record, null, 2)}\n`);

    expect(readLatestReviewAgent(paths, meta.id)?.status).toBe("passed");
  });
});
