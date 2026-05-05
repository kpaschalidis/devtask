import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/errors.js";
import { findRepoRoot, resolvePaths } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("paths", () => {
  it("finds the git root from a nested directory", async () => {
    const repo = await makeTempRepo();
    const nested = path.join(repo, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(repo);
  });

  it("throws when no git repository can be found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-no-git-"));

    try {
      expect(() => findRepoRoot(dir)).toThrow(DevtaskError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the devtask storage layout from the repo root", async () => {
    const repo = await makeTempRepo();

    expect(resolvePaths(repo)).toEqual({
      root: repo,
      baseDir: path.join(repo, ".devtask"),
      configPath: path.join(repo, ".devtask", "config.json"),
      tasksDir: path.join(repo, ".devtask", "tasks"),
      worktreesDir: path.join(repo, ".devtask", "worktrees")
    });
  });
});
