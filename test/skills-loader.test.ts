import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySkillsToDir } from "../src/skills/loader.js";

describe("copySkillsToDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies each skill to .claude/skills and .codex/skills", () => {
    copySkillsToDir(tmpDir, ["commit"]);

    expect(fs.existsSync(path.join(tmpDir, ".claude/skills/commit/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex/skills/commit/SKILL.md"))).toBe(true);
  });

  it("copies multiple skills", () => {
    copySkillsToDir(tmpDir, ["commit", "review"]);

    for (const skill of ["commit", "review"]) {
      expect(fs.existsSync(path.join(tmpDir, `.claude/skills/${skill}/SKILL.md`))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, `.codex/skills/${skill}/SKILL.md`))).toBe(true);
    }
  });

  it("creates directories when they do not exist", () => {
    const nested = path.join(tmpDir, "deep", "nested");
    copySkillsToDir(nested, ["branch"]);

    expect(fs.existsSync(path.join(nested, ".claude/skills/branch/SKILL.md"))).toBe(true);
  });

  it("silently skips unknown skill names", () => {
    expect(() => copySkillsToDir(tmpDir, ["nonexistent-skill"])).not.toThrow();
  });

  it("is idempotent — running twice does not fail", () => {
    copySkillsToDir(tmpDir, ["pr"]);
    expect(() => copySkillsToDir(tmpDir, ["pr"])).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, ".claude/skills/pr/SKILL.md"))).toBe(true);
  });

  it("copied SKILL.md contains the skill name in frontmatter", () => {
    copySkillsToDir(tmpDir, ["branch"]);
    const content = fs.readFileSync(path.join(tmpDir, ".claude/skills/branch/SKILL.md"), "utf8");
    expect(content).toContain("name: branch");
  });
});
