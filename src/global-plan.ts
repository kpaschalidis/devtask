import fs from "node:fs";
import path from "node:path";
import type { DevtaskConfig } from "./infra/config.js";
import { createDefaultAgentRunner, runAgentPrompt } from "./agent.js";
import { writeAgentSessionRegistryEntry } from "./infra/agent-session-registry.js";
import type { DevtaskPaths } from "./infra/paths.js";
import { workItemDir, workItemPhaseRunsDir, workItemPlanRunsDir, workItemSessionRegistryDir, workItemSpecPath } from "./infra/paths.js";
import { emptyPhaseRunSessionMetadata, writePhaseRunRecord } from "./infra/phase-run.js";
import { collectPhaseMemory } from "./improvement-memory.js";
import { newRunId } from "./infra/run-record.js";
import { listWorkspaceRepos, type WorkspaceRepo } from "./storage/workspace-repos.js";
import type { WorkItem } from "./storage/work-store.js";
import { buildGlobalPlanPrompt } from "./prompts/global-plan.js";

export interface WorkPlanRecord {
  schemaVersion: 1;
  phase: "plan";
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
  session: ReturnType<typeof emptyPhaseRunSessionMetadata>;
}

export interface WorkPlanStart {
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
  graphPath: string;
}

export function workPlansDir(paths: DevtaskPaths, id: string): string {
  return workItemPlanRunsDir(paths, id);
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
  const specPath = workItemSpecPath(paths, workItem.id);
  const repos = listWorkspaceRepos(paths);
  const memory = collectPhaseMemory(paths, "planning");
  const prompt = buildGlobalPlanPrompt(paths, workItem, repos, planPath, graphPath, specPath, memory);
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const previousPlan = artifactSnapshot(planPath);
  const previousGraph = artifactSnapshot(graphPath);
  const runner = createDefaultAgentRunner(config);
  const startOptions = {
    workspacePath: paths.root,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    skipGitRepoCheck: true,
    addDirs: workPlanAddDirs(workItem, repos),
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: dir,
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_WORK_PLAN_PATH: planPath,
      DEVTASK_WORK_GRAPH_PATH: graphPath
    }
  } as const;
  const command = runner.buildStartCommand?.(startOptions) ?? "agent-run";
  options.onStart?.({ command, promptPath, outputPath, planPath, graphPath });
  const startedAt = new Date().toISOString();
  const result = await runAgentPrompt(runner, startOptions, prompt, {
    outputPath,
    onOutput: (chunk) => {
      options.onStdout?.(chunk);
    }
  });
  const finishedAt = new Date().toISOString();
  const status =
    result.status === "completed" && isFreshNonEmptyArtifact(planPath, previousPlan) && isFreshValidGraph(graphPath, previousGraph)
      ? "planned"
      : "failed";

  const record: WorkPlanRecord = {
    schemaVersion: 1,
    phase: "plan",
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
    exitCode: result.status === "completed" ? 0 : null,
    session: result.session
  };
  fs.writeFileSync(path.join(runsDir, `${planId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writePhaseRunRecord(workItemPhaseRunsDir(paths, workItem.id, "plan"), {
    schemaVersion: 1,
    phase: "plan",
    runId: planId,
    workId: workItem.id,
    repoId: null,
    taskId: null,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      planPath,
      graphPath
    },
    exitCode: result.status === "completed" ? 0 : null
  });
  writeAgentSessionRegistryEntry(workItemSessionRegistryDir(paths, workItem.id), {
    schemaVersion: 1,
    runId: planId,
    workId: workItem.id,
    phase: "plan",
    repoId: null,
    taskId: null,
    status,
    startedAt,
    finishedAt,
    session: result.session
  });
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
  return buildGlobalPlanPrompt(paths, workItem, repos, planPath, graphPath, workItemSpecPath(paths, workItem.id));
}

export function workPlanAddDirsForTest(workItem: WorkItem, repos: WorkspaceRepo[]): string[] {
  return workPlanAddDirs(workItem, repos);
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


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
