import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./infra/paths.js";

export type MemoryPhase = "planning" | "implementation" | "review";

export function collectPhaseMemory(
  paths: DevtaskPaths,
  phase: MemoryPhase,
  options: { repoId?: string | null } = {}
): string {
  const filePaths = [
    path.join(paths.sharedDir, "improvement", `${phase}.md`),
    path.join(paths.localDir, "improvement", `${phase}.md`),
    options.repoId ? path.join(paths.sharedDir, "improvement", "repos", options.repoId, `${phase}.md`) : null,
    options.repoId ? path.join(paths.localDir, "improvement", "repos", options.repoId, `${phase}.md`) : null,
    ...listArchiveFiles(path.join(paths.sharedDir, "improvement", "archive"), `${phase}.md`),
    ...listArchiveFiles(path.join(paths.localDir, "improvement", "archive"), `${phase}.md`)
  ].filter((value): value is string => Boolean(value));

  const sections = filePaths
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (!content) {
        return null;
      }
      return [`Source: ${filePath}`, "", content].join("\n");
    })
    .filter((value): value is string => Boolean(value));

  if (sections.length === 0) {
    return "";
  }

  return ["Guidance memory:", ...sections.flatMap((section) => ["", section])].join("\n");
}

function listArchiveFiles(root: string, fileName: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const matches: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const currentPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...listArchiveFiles(currentPath, fileName));
      continue;
    }
    if (entry.isFile() && entry.name === fileName) {
      matches.push(currentPath);
    }
  }
  return matches.sort();
}
