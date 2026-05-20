import fs from "node:fs";
import path from "node:path";
import { buildAgentBootstrapCommand } from "./agent.js";
import { DevtaskError } from "./infra/errors.js";
import { readConfig } from "./infra/config.js";
import type { DevtaskPaths } from "./infra/paths.js";
import {
  taskMetaPath,
  workItemDir,
  workItemGraphSnapshotPath,
  workItemMaterializationPath
} from "./infra/paths.js";
import { assertValidTaskId } from "./task-id.js";
import { createTask, initializeStore } from "./storage/task-store.js";
import type { TaskMeta } from "./types.js";
import { getWorkspaceRepo, type WorkspaceRepo } from "./storage/workspace-repos.js";
import type { WorkItem } from "./storage/work-store.js";
import { workGraphPath, workPlanPath } from "./global-plan.js";

export const WORK_DEPENDENCY_TYPES = ["run", "review", "validation"] as const;
export type WorkDependencyType = (typeof WORK_DEPENDENCY_TYPES)[number];

export interface WorkGraphDependency {
  task: string;
  type: WorkDependencyType;
  reason: string | null;
}

export interface WorkGraphTask {
  id: string;
  repoId: string;
  goal: string;
  owns: string[];
  dependencies: WorkGraphDependency[];
}

export interface WorkGraph {
  schemaVersion: 1;
  workId: string;
  tasks: WorkGraphTask[];
  validation: string[];
  openQuestions: string[];
}

export interface MaterializedWorkTask {
  graphTaskId: string;
  repoId: string;
  repoPath: string;
  scope: string | null;
  taskId: string;
  branch: string;
  worktreePath: string;
}

export interface WorkMaterialization {
  schemaVersion: 1;
  workId: string;
  graphSnapshotPath: string;
  materializedAt: string;
  tasks: MaterializedWorkTask[];
}

export async function materializeWorkPlan(paths: DevtaskPaths, workItem: WorkItem): Promise<WorkMaterialization> {
  const graphSnapshotPath = workItemGraphSnapshotPath(paths, workItem.id);
  const materializationPath = workItemMaterializationPath(paths, workItem.id);
  if (fs.existsSync(materializationPath)) {
    throw new DevtaskError(`Work item ${workItem.id} has already been materialized`);
  }

  assertPlanArtifactExists(paths, workItem.id);
  const graph = readAndValidateWorkGraph(paths, workItem.id);
  const repos = resolveGraphRepos(paths, graph);
  preflightMaterialization(repos, graph);

  fs.writeFileSync(graphSnapshotPath, `${JSON.stringify(graph, null, 2)}\n`);

  const tasks: MaterializedWorkTask[] = [];
  for (const graphTask of graph.tasks) {
    const repo = repos.get(graphTask.repoId);
    if (!repo) {
      throw new DevtaskError(`Workspace repo ${graphTask.repoId} does not exist`);
    }
    const repoPaths = resolveRepoPaths(repo);
    initializeStore(repoPaths);
    const meta = await createTask(repoPaths, graphTask.id, {
      goal: buildRepoTaskGoal(paths, workItem, graph, graphTask, repo),
      command: buildMaterializedTaskCommand(paths, repoPaths, workItem)
    });
    tasks.push(toMaterializedTask(graphTask, repo, meta));
  }

  const materialization: WorkMaterialization = {
    schemaVersion: 1,
    workId: workItem.id,
    graphSnapshotPath,
    materializedAt: new Date().toISOString(),
    tasks
  };
  fs.writeFileSync(materializationPath, `${JSON.stringify(materialization, null, 2)}\n`);
  return materialization;
}

export function readWorkGraph(paths: DevtaskPaths, workId: string): WorkGraph {
  return readAndValidateWorkGraph(paths, workId);
}

export function readMaterializedWorkGraph(paths: DevtaskPaths, workId: string): WorkGraph {
  const graphSnapshotPath = workItemGraphSnapshotPath(paths, workId);
  if (!fs.existsSync(graphSnapshotPath)) {
    throw new DevtaskError(`Materialized work graph does not exist: ${graphSnapshotPath}. Run devtask work implement ${workId} first.`);
  }
  return parseWorkGraph(JSON.parse(fs.readFileSync(graphSnapshotPath, "utf8")) as unknown, workId);
}

export function readWorkMaterialization(paths: DevtaskPaths, workId: string): WorkMaterialization | null {
  const materializationPath = workItemMaterializationPath(paths, workId);
  if (!fs.existsSync(materializationPath)) {
    return null;
  }

  return parseWorkMaterialization(JSON.parse(fs.readFileSync(materializationPath, "utf8")) as unknown, workId);
}

function readAndValidateWorkGraph(paths: DevtaskPaths, workId: string): WorkGraph {
  const graphPath = workGraphPath(paths, workId);
  if (!fs.existsSync(graphPath)) {
    throw new DevtaskError(`Work graph does not exist: ${graphPath}. Run devtask work plan ${workId} first.`);
  }
  return parseWorkGraph(JSON.parse(fs.readFileSync(graphPath, "utf8")) as unknown, workId);
}

function assertPlanArtifactExists(paths: DevtaskPaths, workId: string): void {
  const planPath = workPlanPath(paths, workId);
  if (!fs.existsSync(planPath) || fs.readFileSync(planPath, "utf8").trim().length === 0) {
    throw new DevtaskError(`Work plan does not exist: ${planPath}. Run devtask work plan ${workId} first.`);
  }
}

function parseWorkMaterialization(value: unknown, expectedWorkId: string): WorkMaterialization {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new DevtaskError("Invalid work materialization: schemaVersion must be 1");
  }
  const workId = requireString(value, "workId", "work materialization");
  if (workId !== expectedWorkId) {
    throw new DevtaskError(`Invalid work materialization: workId ${workId} does not match ${expectedWorkId}`);
  }
  if (!Array.isArray(value.tasks)) {
    throw new DevtaskError("Invalid work materialization: tasks must be an array");
  }

  return {
    schemaVersion: 1,
    workId,
    graphSnapshotPath: requireString(value, "graphSnapshotPath", "work materialization"),
    materializedAt: requireString(value, "materializedAt", "work materialization"),
    tasks: value.tasks.map(parseMaterializedWorkTask)
  };
}

function parseMaterializedWorkTask(value: unknown): MaterializedWorkTask {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid work materialization: task must be an object");
  }

  return {
    graphTaskId: requireString(value, "graphTaskId", "work materialization"),
    repoId: requireString(value, "repoId", "work materialization"),
    repoPath: requireString(value, "repoPath", "work materialization"),
    scope: parseNullableString(value.scope, "scope"),
    taskId: requireString(value, "taskId", "work materialization"),
    branch: requireString(value, "branch", "work materialization"),
    worktreePath: requireString(value, "worktreePath", "work materialization")
  };
}

function parseWorkGraph(value: unknown, expectedWorkId: string): WorkGraph {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new DevtaskError("Invalid work graph: schemaVersion must be 1");
  }
  const workId = requireString(value, "workId", "work graph");
  if (workId !== expectedWorkId) {
    throw new DevtaskError(`Invalid work graph: workId ${workId} does not match ${expectedWorkId}`);
  }
  if (!Array.isArray(value.tasks)) {
    throw new DevtaskError("Invalid work graph: tasks must be an array");
  }
  const graph: WorkGraph = {
    schemaVersion: 1,
    workId,
    tasks: value.tasks.map(parseWorkGraphTask),
    validation: parseStringArray(value.validation, "validation"),
    openQuestions: parseStringArray(value.openQuestions, "openQuestions")
  };
  validateGraphReferences(graph);
  return graph;
}

function parseWorkGraphTask(value: unknown): WorkGraphTask {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid work graph: task must be an object");
  }
  const id = requireString(value, "id", "work graph");
  assertValidTaskId(id);
  return {
    id,
    repoId: requireString(value, "repoId", "work graph"),
    goal: requireString(value, "goal", "work graph"),
    owns: parseStringArray(value.owns, "owns"),
    dependencies: parseWorkGraphDependencies(value.dependencies)
  };
}

function validateGraphReferences(graph: WorkGraph): void {
  const taskIds = new Set<string>();
  for (const task of graph.tasks) {
    if (taskIds.has(task.id)) {
      throw new DevtaskError(`Invalid work graph: duplicate task id ${task.id}`);
    }
    taskIds.add(task.id);
  }
  for (const task of graph.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency.task)) {
        throw new DevtaskError(`Invalid work graph: task ${task.id} depends on unknown task ${dependency.task}`);
      }
    }
  }
}

function resolveGraphRepos(paths: DevtaskPaths, graph: WorkGraph): Map<string, WorkspaceRepo> {
  const repos = new Map<string, WorkspaceRepo>();
  for (const task of graph.tasks) {
    if (!repos.has(task.repoId)) {
      repos.set(task.repoId, getWorkspaceRepo(paths, task.repoId));
    }
  }
  return repos;
}

function preflightMaterialization(repos: Map<string, WorkspaceRepo>, graph: WorkGraph): void {
  for (const task of graph.tasks) {
    const repo = repos.get(task.repoId);
    if (!repo) {
      throw new DevtaskError(`Workspace repo ${task.repoId} does not exist`);
    }
    const repoPaths = resolveRepoPaths(repo);
    if (fs.existsSync(taskMetaPath(repoPaths, task.id))) {
      throw new DevtaskError(`Task ${task.id} already exists in repo ${repoPaths.root}`);
    }
  }
}

function resolveRepoPaths(repo: WorkspaceRepo): DevtaskPaths {
  // Workspace repos are validated and canonicalized when read.
  return {
    root: repo.repoPath,
    baseDir: path.join(repo.repoPath, ".devtask"),
    configPath: path.join(repo.repoPath, ".devtask", "config.json"),
    tasksDir: path.join(repo.repoPath, ".devtask", "tasks"),
    worktreesDir: path.join(repo.repoPath, ".devtask", "worktrees"),
    workDir: path.join(repo.repoPath, ".devtask", "work")
  };
}

function buildRepoTaskGoal(
  paths: DevtaskPaths,
  workItem: WorkItem,
  graph: WorkGraph,
  task: WorkGraphTask,
  repo: WorkspaceRepo
): string {
  return [
    `Implement work item ${workItem.id}: ${workItem.source.title}`,
    "",
    `Work source artifact: ${workItem.source.artifact}`,
    `Work plan artifact: ${workPlanPath(paths, workItem.id)}`,
    `Work graph artifact: ${workGraphPath(paths, workItem.id)}`,
    `Graph task: ${task.id}`,
    `Repo: ${task.repoId}`,
    `Repo path: ${repo.repoPath}`,
    `Repo scope: ${repo.scope ?? "."}`,
    "",
    "## Goal",
    task.goal,
    "",
    "## Ownership",
    ...task.owns.map((item) => `- ${item}`),
    "",
    "## Dependencies",
    ...(task.dependencies.length
      ? task.dependencies.map((dependency) => `- ${dependency.task} (${dependency.type})${dependency.reason ? `: ${dependency.reason}` : ""}`)
      : ["- none"]),
    "",
    "## Work Graph Context",
    "",
    JSON.stringify(
      {
        workId: graph.workId,
        validation: graph.validation,
        openQuestions: graph.openQuestions
      },
      null,
      2
    )
  ].join("\n");
}

function buildMaterializedTaskCommand(paths: DevtaskPaths, repoPaths: DevtaskPaths, workItem: WorkItem): string {
  const config = readConfig(repoPaths);
  return buildAgentBootstrapCommand(config, {
    workspacePath: repoPaths.root,
    model: config.codex.model,
    fullAuto: config.codex.fullAuto,
    addDirs: [workItemDir(paths, workItem.id), path.dirname(workItem.source.artifact)]
  });
}

function toMaterializedTask(task: WorkGraphTask, repo: WorkspaceRepo, meta: TaskMeta): MaterializedWorkTask {
  return {
    graphTaskId: task.id,
    repoId: task.repoId,
    repoPath: repo.repoPath,
    scope: repo.scope,
    taskId: meta.id,
    branch: meta.branch,
    worktreePath: meta.worktreePath
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DevtaskError(`Invalid work graph: ${field} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new DevtaskError(`Invalid work graph: ${field} must contain only non-empty strings`);
    }
    return item.trim();
  });
}

function parseWorkGraphDependencies(dependencies: unknown): WorkGraphDependency[] {
  const parsed: WorkGraphDependency[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(dependencies)) {
    throw new DevtaskError("Invalid work graph: dependencies must be an array");
  }

  for (const value of dependencies) {
    if (!isRecord(value)) {
      throw new DevtaskError("Invalid work graph: dependency must be an object");
    }
    const task = requireString(value, "task", "work graph dependency");
    const type = parseWorkDependencyType(value.type);
    const key = `${task}:${type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parsed.push({
      task,
      type,
      reason: parseOptionalReason(value.reason)
    });
  }

  return parsed;
}

function parseWorkDependencyType(value: unknown): WorkDependencyType {
  if (typeof value !== "string" || !WORK_DEPENDENCY_TYPES.includes(value as WorkDependencyType)) {
    throw new DevtaskError(`Invalid work graph: dependency type must be one of ${WORK_DEPENDENCY_TYPES.join(", ")}`);
  }
  return value as WorkDependencyType;
}

function parseOptionalReason(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DevtaskError("Invalid work graph dependency: reason must be a string or null");
  }
  return value.trim() || null;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid work materialization: ${field} must be a string or null`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, field: string, artifact = "work graph"): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new DevtaskError(`Invalid ${artifact}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
