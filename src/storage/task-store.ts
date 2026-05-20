import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  resultJsonPath,
  scriptsDir,
  stateMarkdownPath,
  taskDir,
  taskMarkdownPath,
  taskMetaPath,
  workspaceReposPath,
  workspaceJsonPath,
  worktreePath
} from "../infra/paths.js";
import { assertValidTaskId } from "../task-id.js";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import { createTaskWorktree } from "../infra/git.js";
import { DevtaskError } from "../infra/errors.js";
import { reconcileTaskRuntime } from "../task-runtime.js";
import type { TaskMeta, TaskSummary } from "../types.js";
import { readConfig, writeConfig, DEFAULT_CONFIG } from "../infra/config.js";
import { buildAgentBootstrapCommand } from "../agent.js";

export interface CreateTaskOptions {
  goal?: string;
  branch?: string;
  maxRetries?: number;
  command?: string;
  model?: string;
}

export function initializeStore(paths: DevtaskPaths): void {
  fs.mkdirSync(paths.tasksDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  fs.mkdirSync(paths.workDir, { recursive: true });
  if (!fs.existsSync(paths.configPath)) {
    writeConfig(paths, DEFAULT_CONFIG);
  }
}

export function initializeWorkspace(paths: DevtaskPaths): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.mkdirSync(paths.workDir, { recursive: true });
  fs.mkdirSync(scriptsDir(paths), { recursive: true });
  if (!fs.existsSync(paths.configPath)) {
    writeConfig(paths, DEFAULT_CONFIG);
  }
  const markerPath = workspaceJsonPath(paths);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "workspace",
          createdAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  }
  const reposPath = workspaceReposPath(paths);
  if (!fs.existsSync(reposPath)) {
    fs.writeFileSync(reposPath, `${JSON.stringify({ schemaVersion: 1, repos: [] }, null, 2)}\n`);
  }
}

export async function createTask(
  paths: DevtaskPaths,
  id: string,
  options: CreateTaskOptions = {}
): Promise<TaskMeta> {
  assertValidTaskId(id);
  initializeStore(paths);

  const dir = taskDir(paths, id);
  const metaFile = taskMetaPath(paths, id);

  if (fs.existsSync(metaFile)) {
    throw new DevtaskError(`Task ${id} already exists`);
  }

  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });

  const branch = options.branch ?? `task/${id}`;
  const maxRetries = options.maxRetries ?? 5;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new DevtaskError("maxRetries must be a positive integer");
  }

  const taskPath = taskMarkdownPath(paths, id);
  const statePath = stateMarkdownPath(paths, id);
  const resultPath = resultJsonPath(paths, id);
  const targetWorktreePath = worktreePath(paths, id);
  const now = new Date().toISOString();
  const config = readConfig(paths);
  const model = options.model ?? config.codex.model;
  const defaultCommand = buildAgentBootstrapCommand(config, {
    workspacePath: targetWorktreePath,
    model,
    fullAuto: config.codex.fullAuto
  });

  fs.writeFileSync(
    taskPath,
    `# Task ${id}\n\n## Goal\n${options.goal ?? ""}\n\n## Instructions\n- Work inside the task worktree.\n- Keep this task stateful and update the file at $DEVTASK_STATE_PATH as work progresses.\n- When the task is complete, inspect the final diff and commit the scoped task changes before writing the final result.\n- When the task is complete, write {"status":"done"} to the file at $DEVTASK_RESULT_PATH.\n- If the task is blocked or cannot be completed, write {"status":"blocked","reason":"..."} to the file at $DEVTASK_RESULT_PATH.\n`
  );
  fs.writeFileSync(statePath, `# State: ${id}\n\n## Progress\n- Created ${now}\n`);
  fs.writeFileSync(resultPath, "{\n  \"status\": \"pending\"\n}\n");

  await createTaskWorktree(paths.root, branch, targetWorktreePath);

  const meta: TaskMeta = {
    schemaVersion: 1,
    id,
    status: "created",
    runtime: null,
    branch,
    worktreePath: targetWorktreePath,
    taskPath,
    statePath,
    resultPath,
    model,
    command: options.command ?? defaultCommand,
    supervisorPid: null,
    childPid: null,
    tmuxSession: null,
    agentSessionMode: null,
    prUrl: null,
    failCount: 0,
    maxRetries,
    createdAt: now,
    updatedAt: now
  };

  writeTaskMeta(metaFile, meta);
  return meta;
}

export function listTasks(paths: DevtaskPaths): TaskSummary[] {
  if (!fs.existsSync(paths.tasksDir)) {
    return [];
  }

  return fs
    .readdirSync(paths.tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTaskMeta(taskMetaPath(paths, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((meta) => ({
      id: meta.id,
      status: meta.status,
      branch: meta.branch,
      worktreePath: meta.worktreePath,
      supervisorPid: meta.supervisorPid,
      childPid: meta.childPid,
      failCount: meta.failCount,
      maxRetries: meta.maxRetries,
      updatedAt: meta.updatedAt
    }));
}

export function getTask(paths: DevtaskPaths, id: string): TaskMeta {
  assertValidTaskId(id);
  const metaFile = taskMetaPath(paths, id);
  if (!fs.existsSync(metaFile)) {
    throw new DevtaskError(`Task ${id} does not exist`);
  }
  return reconcileTaskRuntime(paths, readTaskMeta(metaFile));
}
