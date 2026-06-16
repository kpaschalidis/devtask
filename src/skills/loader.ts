import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = path.dirname(fileURLToPath(import.meta.url));

const AGENT_SKILL_DIRS = [".claude/skills", ".codex/skills"];

export function copySkillsToDir(targetDir: string, skillNames: string[]): void {
  for (const skillName of skillNames) {
    const sourcePath = path.join(SKILLS_DIR, skillName, "SKILL.md");
    if (!fs.existsSync(sourcePath)) continue;

    const content = fs.readFileSync(sourcePath);
    for (const agentDir of AGENT_SKILL_DIRS) {
      const destDir = path.join(targetDir, agentDir, skillName);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "SKILL.md"), content);
    }
  }
}
