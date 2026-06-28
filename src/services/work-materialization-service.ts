import fs from "node:fs";
import path from "node:path";
import { buildAgentBootstrapCommand } from "../adapters/agent-kernel/command.js";
import { DevtaskError } from "../infra/errors.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  planMarkdownPath,
  taskMetaPath,
  taskStoragePaths,
  workItemDir,
  workItemGraphPath,
  workItemGraphSnapshotPath,
  workItemMaterializationPath,
  workItemPlanPath,
  workItemRepoContextPath
} from "../infra/paths.js";
import { assertValidTaskId } from "../task-id.js";
import { createTask, initializeStore } from "../storage/task-store.js";
import { writeTaskMeta } from "../storage/meta.js";
import type { TaskMeta } from "../types.js";
import { getWorkspaceRepo, type WorkspaceRepo } from "../storage/workspace-repos.js";
import type { WorkItem } from "../storage/work-store.js";
import { resolvePaths } from "../infra/paths.js";

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
  featureId: string | null;
  goal: string;
  owns: string[];
  dependencies: WorkGraphDependency[];
}

export interface WorkGraphFeature {
  id: string;
  title: string;
  taskIds: string[];
  validationRequired: boolean;
}

export interface WorkGraph {
  schemaVersion: 1;
  workId: string;
  kind: "feature" | "bugfix" | "refactor";
  tasks: WorkGraphTask[];
  features: WorkGraphFeature[];
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
  preflightMaterialization(paths, repos, graph);

  fs.writeFileSync(graphSnapshotPath, `${JSON.stringify(graph, null, 2)}\n`);

  const tasks: MaterializedWorkTask[] = [];
  for (const graphTask of graph.tasks) {
    const repo = repos.get(graphTask.repoId);
    if (!repo) {
      throw new DevtaskError(`Workspace repo ${graphTask.repoId} does not exist`);
    }
    const repoPaths = resolveRepoPaths(repo);
    const storagePaths = taskStoragePaths(paths, repo.repoPath);
    initializeStore(storagePaths);
    const branch = buildMaterializedTaskBranch(graph.kind, workItem.id, graphTask.id);
    const meta = await createTask(storagePaths, graphTask.id, {
      goal: buildRepoTaskGoal(paths, workItem, graph, graphTask, repo),
      command: buildMaterializedTaskCommand(paths, repoPaths, workItem),
      repoRoot: repoPaths.root,
      branch,
      worktreePath: path.join(paths.worktreesDir, graphTask.repoId, branch)
    });
    const hydratedMeta = hydrateMaterializedTaskPlan(paths, workItem.id, graphTask.repoId, storagePaths, meta);
    tasks.push(toMaterializedTask(graphTask, repo, hydratedMeta));
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

function buildMaterializedTaskBranch(kind: WorkGraph["kind"], workId: string, taskId: string): string {
  return `${kind}/${workId}-${taskId}`;
}

export function readWorkGraph(paths: DevtaskPaths, workId: string): WorkGraph {
  return readAndValidateWorkGraph(paths, workId);
}

export function readMaterializedWorkGraph(paths: DevtaskPaths, workId: string): WorkGraph {
  const graphSnapshotPath = workItemGraphSnapshotPath(paths, workId);
  if (!fs.existsSync(graphSnapshotPath)) {
    throw new DevtaskError(`Materialized work graph does not exist: ${graphSnapshotPath}. Run devtask work materialize ${workId} first.`);
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
  const graphPath = workItemGraphPath(paths, workId);
  if (!fs.existsSync(graphPath)) {
    throw new DevtaskError(`Work graph does not exist: ${graphPath}. Run devtask work plan ${workId} first.`);
  }
  return parseWorkGraph(JSON.parse(fs.readFileSync(graphPath, "utf8")) as unknown, workId);
}

function assertPlanArtifactExists(paths: DevtaskPaths, workId: string): void {
  const planPath = workItemPlanPath(paths, workId);
  if (!fs.existsSync(planPath) || fs.readFileSync(planPath, "utf8").trim().length === 0) {
    throw new DevtaskError(`Work plan does not exist: ${planPath}. Run devtask work orchestrate ${workId} first.`);
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
  const rawFeatures = Array.isArray(value.features) ? value.features : [];
  const rawKind = value.kind;
  const kind: WorkGraph["kind"] = rawKind === "bugfix" || rawKind === "refactor" ? rawKind : "feature";
  const graph: WorkGraph = {
    schemaVersion: 1,
    workId,
    kind,
    tasks: value.tasks.map(parseWorkGraphTask),
    features: rawFeatures.map(parseWorkGraphFeature),
    validation: parseStringArray(value.validation, "validation"),
    openQuestions: parseStringArray(value.openQuestions, "openQuestions")
  };

  validateGraph(graph);
  return graph;
}

function parseWorkGraphTask(value: unknown): WorkGraphTask {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid work graph: task must be an object");
  }

  return {
    id: requireString(value, "id", "work graph task"),
    repoId: requireString(value, "repoId", "work graph task"),
    featureId: parseNullableString(value.featureId, "featureId"),
    goal: requireString(value, "goal", "work graph task"),
    owns: parseStringArray(value.owns, "owns"),
    dependencies: parseDependencies(value.dependencies)
  };
}

function parseWorkGraphFeature(value: unknown): WorkGraphFeature {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid work graph: feature must be an object");
  }

  return {
    id: requireString(value, "id", "work graph feature"),
    title: requireString(value, "title", "work graph feature"),
    taskIds: parseStringArray(value.taskIds, "taskIds"),
    validationRequired: Boolean(value.validationRequired)
  };
}

function parseDependencies(value: unknown): WorkGraphDependency[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new DevtaskError("Invalid work graph dependency: must be an object");
    }
    const type = requireString(entry, "type", "work graph dependency");
    if (!WORK_DEPENDENCY_TYPES.includes(type as WorkDependencyType)) {
      throw new DevtaskError(`Invalid work graph dependency type: ${type}; dependency type must be one of ${WORK_DEPENDENCY_TYPES.join(", ")}`);
    }
    return {
      task: requireString(entry, "task", "work graph dependency"),
      type: type as WorkDependencyType,
      reason: parseNullableString(entry.reason, "reason")
    };
  });
}

function validateGraph(graph: WorkGraph): void {
  const taskIds = new Set<string>();
  const repoTaskIds = new Set<string>();
  const featureIds = new Set<string>();

  for (const feature of graph.features) {
    if (featureIds.has(feature.id)) {
      throw new DevtaskError(`Duplicate feature id in work graph: ${feature.id}`);
    }
    featureIds.add(feature.id);
  }

  for (const task of graph.tasks) {
    if (taskIds.has(task.id)) {
      throw new DevtaskError(`Duplicate task id in work graph: ${task.id}`);
    }
    taskIds.add(task.id);

    const repoTaskKey = `${task.repoId}:${task.id}`;
    if (repoTaskIds.has(repoTaskKey)) {
      throw new DevtaskError(`Duplicate repo task in work graph: ${repoTaskKey}`);
    }
    repoTaskIds.add(repoTaskKey);

    if (task.featureId && !featureIds.has(task.featureId)) {
      throw new DevtaskError(`Task ${task.id} references unknown feature ${task.featureId}`);
    }
  }

  for (const task of graph.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency.task)) {
        throw new DevtaskError(`Task ${task.id} depends on unknown task ${dependency.task}`);
      }
    }
  }

  for (const feature of graph.features) {
    for (const taskId of feature.taskIds) {
      if (!taskIds.has(taskId)) {
        throw new DevtaskError(`Feature ${feature.id} references unknown task ${taskId}`);
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

function preflightMaterialization(paths: DevtaskPaths, repos: Map<string, WorkspaceRepo>, graph: WorkGraph): void {
  const branchCollisions = new Set<string>();
  for (const task of graph.tasks) {
    const branch = buildMaterializedTaskBranch(graph.kind, graph.workId, task.id);
    const key = `${task.repoId}:${branch}`;
    if (branchCollisions.has(key)) {
      throw new DevtaskError(`Duplicate task branch during materialization: ${key}`);
    }
    branchCollisions.add(key);
  }

  for (const repo of repos.values()) {
    const repoPaths = resolveRepoPaths(repo);
    if (!fs.existsSync(repoPaths.root)) {
      throw new DevtaskError(`Workspace repo path does not exist: ${repoPaths.root}`);
    }
  }

  const materializationPath = workItemMaterializationPath(paths, graph.workId);
  if (fs.existsSync(materializationPath)) {
    throw new DevtaskError(`Work item ${graph.workId} has already been materialized`);
  }
}

function resolveRepoPaths(repo: WorkspaceRepo): { root: string; scopePath: string } {
  const root = resolvePaths(repo.repoPath).root;
  const scopePath = repo.scope ? path.join(root, repo.scope) : root;
  return { root, scopePath };
}

function buildRepoTaskGoal(
  paths: DevtaskPaths,
  workItem: WorkItem,
  graph: WorkGraph,
  graphTask: WorkGraphTask,
  repo: WorkspaceRepo
): string {
  const dependencyLines = graphTask.dependencies.length === 0
    ? ["- none"]
    : graphTask.dependencies.map((dependency) => {
        const reasonSuffix = dependency.reason ? `: ${dependency.reason}` : "";
        return `- ${dependency.task} (${dependency.type})${reasonSuffix}`;
      });
  const ownershipLines = graphTask.owns.length === 0 ? ["- none"] : graphTask.owns.map((entry) => `- ${entry}`);
  const repoContextPath = workItemRepoContextPath(paths, workItem.id, graphTask.repoId);
  const repoContext = fs.existsSync(repoContextPath)
    ? fs.readFileSync(repoContextPath, "utf8").trim()
    : "";

  return [
    `# Task ${graphTask.id}`,
    "",
    "## Goal",
    graphTask.goal,
    "",
    "## Work Item",
    `- id: ${workItem.id}`,
    `- title: ${workItem.source.title}`,
    `- source artifact: ${workItem.source.artifact}`,
    "",
    "## Repository",
    `- repo id: ${repo.id}`,
    `- repo path: ${repo.repoPath}`,
    `- repo scope: ${repo.scope ?? "."}`,
    "",
    "## Ownership",
    ...ownershipLines,
    "",
    "## Dependencies",
    ...dependencyLines,
    ...(repoContext ? ["", "## Orchestrator Context", repoContext] : []),
    "",
    "## Graph Snapshot",
    `- graph path: ${workItemGraphPath(paths, workItem.id)}`,
    `- feature id: ${graphTask.featureId ?? "none"}`,
    `- graph kind: ${graph.kind}`
  ].join("\n");
}

function buildMaterializedTaskCommand(
  paths: DevtaskPaths,
  repoPaths: { root: string; scopePath: string },
  workItem: WorkItem
): string {
  const config = readConfig(paths);
  return buildAgentBootstrapCommand(config, {
    workspacePath: repoPaths.root,
    addDirs: [workItemDir(paths, workItem.id), repoPaths.scopePath],
  });
}

function hydrateMaterializedTaskPlan(
  paths: DevtaskPaths,
  workId: string,
  repoId: string,
  storagePaths: DevtaskPaths,
  meta: TaskMeta
): TaskMeta {
  const finalPlanPath = planMarkdownPath(storagePaths, meta.id);
  const repoPlanPath = path.join(workItemDir(paths, workId), "repo-plans", `${repoId}.md`);
  if (fs.existsSync(repoPlanPath) && fs.readFileSync(repoPlanPath, "utf8").trim()) {
    const repoContextPath = workItemRepoContextPath(paths, workId, repoId);
    const repoContext = fs.existsSync(repoContextPath) ? fs.readFileSync(repoContextPath, "utf8").trim() : "";
    const repoPlan = fs.readFileSync(repoPlanPath, "utf8").trimEnd();
    fs.mkdirSync(path.dirname(finalPlanPath), { recursive: true });
    fs.writeFileSync(
      finalPlanPath,
      `${repoPlan}${repoContext ? `\n\n## Orchestrator Context\n${repoContext}\n` : "\n"}`
    );
  }
  writeTaskMeta(taskMetaPath(storagePaths, meta.id), meta);
  return meta;
}

function toMaterializedTask(graphTask: WorkGraphTask, repo: WorkspaceRepo, meta: TaskMeta): MaterializedWorkTask {
  return {
    graphTaskId: graphTask.id,
    repoId: graphTask.repoId,
    repoPath: repo.repoPath,
    scope: repo.scope,
    taskId: meta.id,
    branch: meta.branch,
    worktreePath: meta.worktreePath
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, scope: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new DevtaskError(`Invalid ${scope}: ${key} must be a non-empty string`);
  }
  return raw;
}

function parseNullableString(value: unknown, key: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid value for ${key}: expected string or null`);
  }
  return value;
}

function parseStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new DevtaskError(`Invalid ${key}: expected string[]`);
    }
    return entry;
  });
}
