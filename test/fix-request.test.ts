import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixRequestFromCheck, readActiveFixRequest } from "../src/fix-request.js";
import { resolvePaths, taskDir } from "../src/paths.js";
import { createTask } from "../src/task-store.js";
import { runVerification } from "../src/verification.js";
import { makeTempRepo } from "./helpers.js";

describe("fix requests", () => {
  it("creates an explicit check-failure repair artifact", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    const meta = await createTask(paths, "fix-check");
    fs.writeFileSync(path.join(meta.worktreePath, "package.json"), "{}\n");
    await runVerification(paths, meta, ["node -e \"console.error('type error'); process.exit(2)\""]);

    const request = createFixRequestFromCheck(paths, meta);

    expect(request).toMatchObject({
      schemaVersion: 1,
      taskId: "fix-check",
      source: "check",
      summary: "Check failed: node -e \"console.error('type error'); process.exit(2)\""
    });
    expect(fs.existsSync(request.promptPath)).toBe(true);
    expect(fs.readFileSync(request.promptPath, "utf8")).toContain("type error");
    expect(readActiveFixRequest(paths, meta.id)?.fixId).toBe(request.fixId);
    expect(fs.existsSync(path.join(taskDir(paths, meta.id), "fixes", `${request.fixId}.json`))).toBe(true);
  });
});
