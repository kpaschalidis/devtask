import fs from "node:fs";
import path from "node:path";
import type { DevtaskConfig } from "./config.js";
import { buildCodexCommand } from "./config.js";
import { groupDir, type TaskGroup } from "./group-store.js";
import { planMarkdownPath, resolvePaths, taskDir, taskMarkdownPath, type DevtaskPaths, worktreePath } from "./paths.js";
import { runCommand } from "./process-runner.js";
import { newRunId } from "./run-record.js";

export interface GroupOrchestrationRecord {
  schemaVersion: 1;
  orchestrationId: string;
  groupId: string;
  status: "planned" | "failed";
  command: string;
  promptPath: string;
  outputPath: string;
  orchestrationPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
}

export interface GroupOrchestrationStart {
  command: string;
  promptPath: string;
  outputPath: string;
  orchestrationPath: string;
}

export function groupOrchestrationPath(paths: DevtaskPaths, id: string): string {
  return path.join(groupDir(paths, id), "orchestration.md");
}

export function readGroupOrchestration(paths: DevtaskPaths, id: string): string {
  return readTextIfExists(groupOrchestrationPath(paths, id)).trim();
}

export function hasGroupOrchestration(paths: DevtaskPaths, id: string): boolean {
  return readGroupOrchestration(paths, id).length > 0;
}

export async function runGroupOrchestrator(
  paths: DevtaskPaths,
  group: TaskGroup,
  config: DevtaskConfig,
  options: {
    onStart?: (start: GroupOrchestrationStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {}
): Promise<GroupOrchestrationRecord> {
  const orchestrationId = newRunId();
  const dir = groupDir(paths, group.id);
  const runsDir = path.join(dir, "orchestrations");
  fs.mkdirSync(runsDir, { recursive: true });

  const promptPath = path.join(runsDir, `${orchestrationId}.prompt.md`);
  const outputPath = path.join(runsDir, `${orchestrationId}.md`);
  const orchestrationPath = groupOrchestrationPath(paths, group.id);
  const prompt = buildGroupOrchestrationPrompt(paths, group, orchestrationPath);
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const previousArtifact = artifactSnapshot(orchestrationPath);
  const command = buildCodexCommand({
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: groupOrchestrationAddDirs(group)
  });
  options.onStart?.({ command, promptPath, outputPath, orchestrationPath });
  const startedAt = new Date().toISOString();
  const output = fs.createWriteStream(outputPath, { flags: "w" });
  const result = await runCommand("sh", ["-c", command], {
    cwd: paths.root,
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: dir,
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_ORCHESTRATION_PATH: orchestrationPath
    },
    onStdout: (chunk) => {
      output.write(chunk);
      options.onStdout?.(chunk);
    },
    onStderr: (chunk) => {
      output.write(chunk);
      options.onStderr?.(chunk);
    }
  });
  await closeStream(output);
  const finishedAt = new Date().toISOString();
  const status =
    result.exitCode === 0 && isFreshOrchestrationArtifact(orchestrationPath, previousArtifact) ? "planned" : "failed";

  const record: GroupOrchestrationRecord = {
    schemaVersion: 1,
    orchestrationId,
    groupId: group.id,
    status,
    command,
    promptPath,
    outputPath,
    orchestrationPath,
    startedAt,
    finishedAt,
    exitCode: result.exitCode
  };
  fs.writeFileSync(path.join(runsDir, `${orchestrationId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function buildGroupOrchestrationPromptForTest(paths: DevtaskPaths, group: TaskGroup, orchestrationPath: string): string {
  return buildGroupOrchestrationPrompt(paths, group, orchestrationPath);
}

export function groupOrchestrationAddDirsForTest(group: TaskGroup): string[] {
  return groupOrchestrationAddDirs(group);
}

export function isFreshOrchestrationArtifactForTest(
  filePath: string,
  previous: { exists: boolean; mtimeMs: number | null }
): boolean {
  return isFreshOrchestrationArtifact(filePath, previous);
}

function buildGroupOrchestrationPrompt(paths: DevtaskPaths, group: TaskGroup, orchestrationPath: string): string {
  return [
    `Create a group orchestration plan for ${group.id}.`,
    "",
    "You are in the devtask group orchestration stage.",
    "",
    "Role:",
    "- Coordinate a multi-repo task.",
    "- Do not implement code.",
    "- Do not edit repository files.",
    "- Do not run tests or mutate git state.",
    `- Write only the orchestration artifact: ${orchestrationPath}.`,
    "",
    "Group goal:",
    "",
    group.goal?.trim() || "(no group goal provided)",
    "",
    "Member repositories:",
    "",
    ...group.repos.map((repo) => [`- ${repo.name}`, `  - path: ${repo.path}`, `  - task: ${repo.taskId}`].join("\n")),
    "",
    "Repo task artifacts:",
    "",
    ...group.repos.map((repo) => {
      const repoPaths = resolvePaths(repo.path);
      const taskPath = taskMarkdownPath(repoPaths, repo.taskId);
      const planPath = planMarkdownPath(repoPaths, repo.taskId);
      return [
        `- ${repo.name}`,
        `  - task file: ${taskPath}`,
        `  - existing repo plan: ${fs.existsSync(planPath) ? planPath : "(none yet)"}`
      ].join("\n");
    }),
    "",
    "Write the orchestration plan with these Markdown sections:",
    "1. Summary",
    "2. Source Inputs",
    "3. Affected Repositories",
    "4. Cross-Repo Contract",
    "5. Repo Responsibilities",
    "6. Dependencies and Execution Order",
    "7. Ownership Boundaries",
    "8. Validation Plan",
    "9. Risks and Assumptions",
    "10. Open Questions",
    "",
    "Rules:",
    "- Convert repo-local assumptions into explicit cross-repo contracts.",
    "- Assign each responsibility to exactly one repo when possible.",
    "- Include rejected or not-selected repos only if they are present in the group goal or repo list.",
    "- Use explicit dependencies; do not rely on natural-language implication.",
    "- If repo-local plans already exist, read them and reconcile their contracts into this group plan.",
    "- Keep repo implementation details high-level enough for repo-local planners to refine.",
    "- Prefer existing repo boundaries from the group metadata over guessing new repositories.",
    "- If a contract is unknown, mark it as an open question instead of inventing behavior.",
    "",
    `Workspace root: ${paths.root}`
  ].join("\n");
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function groupOrchestrationAddDirs(group: TaskGroup): string[] {
  const dirs = new Set<string>();
  for (const repo of group.repos) {
    const repoPaths = resolvePaths(repo.path);
    dirs.add(taskDir(repoPaths, repo.taskId));
    const worktree = worktreePath(repoPaths, repo.taskId);
    if (fs.existsSync(worktree)) {
      dirs.add(worktree);
    }
  }
  return [...dirs];
}

function artifactSnapshot(filePath: string): { exists: boolean; mtimeMs: number | null } {
  try {
    return {
      exists: true,
      mtimeMs: fs.statSync(filePath).mtimeMs
    };
  } catch {
    return {
      exists: false,
      mtimeMs: null
    };
  }
}

function isFreshOrchestrationArtifact(filePath: string, previous: { exists: boolean; mtimeMs: number | null }): boolean {
  const content = readTextIfExists(filePath).trim();
  if (!content) {
    return false;
  }

  let currentMtimeMs: number;
  try {
    currentMtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return false;
  }

  return !previous.exists || previous.mtimeMs === null || currentMtimeMs > previous.mtimeMs;
}
