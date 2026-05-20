import fs from "node:fs";
import path from "node:path";
import type { DevtaskConfig } from "./config.js";
import { buildCodexCommand } from "./config.js";
import type { DevtaskPaths } from "./paths.js";
import { workItemDir } from "./paths.js";
import { runCommand } from "./process-runner.js";
import { newRunId } from "./run-record.js";
import { listWorkspaceRepos, type WorkspaceRepo } from "./workspace-repos.js";
import type { WorkItem } from "./work-store.js";

export interface WorkPlanRecord {
  schemaVersion: 1;
  planId: string;
  workId: string;
  status: "planned" | "failed";
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
  graphPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
}

export interface WorkPlanStart {
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
  graphPath: string;
}

export function workPlansDir(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "plans");
}

export function workPlanPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "plan.md");
}

export function workGraphPath(paths: DevtaskPaths, id: string): string {
  return path.join(workItemDir(paths, id), "graph.json");
}

export function readWorkPlan(paths: DevtaskPaths, id: string): string {
  return readTextIfExists(workPlanPath(paths, id)).trim();
}

export async function runWorkPlanner(
  paths: DevtaskPaths,
  workItem: WorkItem,
  config: DevtaskConfig,
  options: {
    onStart?: (start: WorkPlanStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {}
): Promise<WorkPlanRecord> {
  const planId = newRunId();
  const dir = workItemDir(paths, workItem.id);
  const runsDir = workPlansDir(paths, workItem.id);
  fs.mkdirSync(runsDir, { recursive: true });

  const promptPath = path.join(runsDir, `${planId}.prompt.md`);
  const outputPath = path.join(runsDir, `${planId}.md`);
  const planPath = workPlanPath(paths, workItem.id);
  const graphPath = workGraphPath(paths, workItem.id);
  const repos = listWorkspaceRepos(paths);
  const prompt = buildWorkPlanPrompt(paths, workItem, repos, planPath, graphPath);
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const previousPlan = artifactSnapshot(planPath);
  const previousGraph = artifactSnapshot(graphPath);
  const command = buildCodexCommand({
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: workPlanAddDirs(workItem, repos)
  });
  options.onStart?.({ command, promptPath, outputPath, planPath, graphPath });
  const startedAt = new Date().toISOString();
  const output = fs.createWriteStream(outputPath, { flags: "w" });
  const result = await runCommand("sh", ["-c", command], {
    cwd: paths.root,
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: dir,
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_WORK_PLAN_PATH: planPath,
      DEVTASK_WORK_GRAPH_PATH: graphPath
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
    result.exitCode === 0 && isFreshNonEmptyArtifact(planPath, previousPlan) && isFreshValidGraph(graphPath, previousGraph)
      ? "planned"
      : "failed";

  const record: WorkPlanRecord = {
    schemaVersion: 1,
    planId,
    workId: workItem.id,
    status,
    command,
    promptPath,
    outputPath,
    planPath,
    graphPath,
    startedAt,
    finishedAt,
    exitCode: result.exitCode
  };
  fs.writeFileSync(path.join(runsDir, `${planId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readLatestWorkPlanRecord(paths: DevtaskPaths, id: string): WorkPlanRecord | null {
  const runsDir = workPlansDir(paths, id);
  if (!fs.existsSync(runsDir)) {
    return null;
  }

  const latest = fs
    .readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1);

  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(runsDir, latest), "utf8")) as WorkPlanRecord;
}

export function buildWorkPlanPromptForTest(
  paths: DevtaskPaths,
  workItem: WorkItem,
  repos: WorkspaceRepo[],
  planPath: string,
  graphPath: string
): string {
  return buildWorkPlanPrompt(paths, workItem, repos, planPath, graphPath);
}

export function workPlanAddDirsForTest(workItem: WorkItem, repos: WorkspaceRepo[]): string[] {
  return workPlanAddDirs(workItem, repos);
}

function buildWorkPlanPrompt(
  paths: DevtaskPaths,
  workItem: WorkItem,
  repos: WorkspaceRepo[],
  planPath: string,
  graphPath: string
): string {
  return [
    `Plan work item ${workItem.id}.`,
    "",
    "You are in the devtask work planning activity.",
    "",
    "Role:",
    "- Read the work source and workspace repo inventory.",
    "- Decide which repos are likely affected.",
    "- Produce a proposed execution graph only.",
    "- Do not create repo tasks.",
    "- Do not implement code.",
    "- Do not edit repository files.",
    "- Do not run tests or mutate git state.",
    `- Write the human-readable plan to: ${planPath}.`,
    `- Write the machine-readable graph JSON to: ${graphPath}.`,
    "",
    "Work source:",
    "",
    `- type: ${workItem.source.type}`,
    `- title: ${workItem.source.title}`,
    `- artifact: ${workItem.source.artifact}`,
    ...("url" in workItem.source ? [`- url: ${workItem.source.url}`] : []),
    "",
    "Workspace repos:",
    "",
    ...(repos.length
      ? repos.map((repo) =>
          [
            `- ${repo.id}`,
            `  - kind: ${repo.kind ?? "-"}`,
            `  - path: ${repo.repoPath}`,
            `  - scope: ${repo.scope ?? "."}`
          ].join("\n")
        )
      : ["- (none configured)"]),
    "",
    "Read the work source artifact before planning.",
    "",
    "Markdown plan sections:",
    "1. Summary",
    "2. Source Inputs",
    "3. Affected Repos",
    "4. Proposed Execution Graph",
    "5. Ownership Boundaries",
    "6. Dependencies",
    "7. Validation Plan",
    "8. Risks and Open Questions",
    "",
    "Graph JSON schema:",
    "",
    "```json",
    "{",
    '  "schemaVersion": 1,',
    `  "workId": "${workItem.id}",`,
    '  "tasks": [',
    "    {",
    '      "id": "short-task-id",',
    '      "repoId": "workspace-repo-id",',
    '      "goal": "repo/scope-local goal",',
    '      "owns": ["path/or/scope/**"],',
    '      "dependencies": [',
    "        {",
    '          "task": "other-task-id",',
    '          "type": "run|review|validation",',
    '          "reason": "why this dependency exists"',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "validation": ["check command or validation responsibility"],',
    '  "openQuestions": []',
    "}",
    "```",
    "",
    "Rules:",
    "- Use only configured workspace repos; do not invent repo IDs.",
    "- If no configured repo clearly applies, output an empty tasks array and explain the open question.",
    "- Prefer explicit ownership boundaries over broad repository ownership.",
    "- Dependencies must reference proposed task ids.",
    "- Use dependency type `run` only when the dependent task cannot safely start before the dependency is done.",
    "- Use `validation` when tasks can implement in parallel but final integration validation depends on both.",
    "- Prefer parallel execution unless there is a concrete dependency blocker.",
    "- Keep the graph proposed only; a later materialization step will create repo-local tasks and worktrees.",
    "- The graph file must contain JSON only, with no Markdown fences.",
    "",
    `Workspace root: ${paths.root}`
  ].join("\n");
}

function workPlanAddDirs(workItem: WorkItem, repos: WorkspaceRepo[]): string[] {
  const dirs = new Set<string>([path.dirname(workItem.source.artifact)]);
  for (const repo of repos) {
    dirs.add(repo.scope ? path.join(repo.repoPath, repo.scope) : repo.repoPath);
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

function isFreshNonEmptyArtifact(filePath: string, previous: { exists: boolean; mtimeMs: number | null }): boolean {
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

function isFreshValidGraph(filePath: string, previous: { exists: boolean; mtimeMs: number | null }): boolean {
  if (!isFreshNonEmptyArtifact(filePath, previous)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) && parsed.schemaVersion === 1 && Array.isArray(parsed.tasks);
  } catch {
    return false;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
