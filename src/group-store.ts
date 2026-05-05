import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "./errors.js";
import type { DevtaskPaths } from "./paths.js";
import { assertValidTaskId } from "./task-id.js";

export interface TaskGroupRepo {
  name: string;
  path: string;
  taskId: string;
}

export interface TaskGroup {
  schemaVersion: 1;
  id: string;
  goal: string | null;
  repos: TaskGroupRepo[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupOptions {
  goal?: string;
}

export interface AddGroupRepoOptions {
  name: string;
  repoPath: string;
  taskId: string;
}

export function createGroup(paths: DevtaskPaths, id: string, options: CreateGroupOptions = {}): TaskGroup {
  assertValidTaskId(id);
  fs.mkdirSync(paths.groupsDir, { recursive: true });

  const dir = groupDir(paths, id);
  const filePath = groupJsonPath(paths, id);
  if (fs.existsSync(filePath)) {
    throw new DevtaskError(`Group ${id} already exists`);
  }

  const now = new Date().toISOString();
  const group: TaskGroup = {
    schemaVersion: 1,
    id,
    goal: options.goal ?? null,
    repos: [],
    createdAt: now,
    updatedAt: now
  };

  fs.mkdirSync(dir, { recursive: true });
  writeGroup(paths, group);
  fs.writeFileSync(path.join(dir, "state.md"), `# State: ${id}\n\n## Progress\n- Created ${now}\n`);
  fs.writeFileSync(path.join(dir, "plan.md"), `# Plan: ${id}\n\n## Goal\n${options.goal ?? ""}\n`);
  return group;
}

export function addRepoToGroup(paths: DevtaskPaths, id: string, options: AddGroupRepoOptions): TaskGroup {
  const group = getGroup(paths, id);
  assertValidTaskId(options.taskId);
  assertValidRepoName(options.name);

  const repoPath = path.resolve(options.repoPath);
  if (!fs.existsSync(repoPath)) {
    throw new DevtaskError(`Repo path does not exist: ${repoPath}`);
  }

  if (group.repos.some((repo) => repo.name === options.name)) {
    throw new DevtaskError(`Group ${id} already has repo ${options.name}`);
  }
  if (group.repos.some((repo) => repo.path === repoPath)) {
    throw new DevtaskError(`Group ${id} already has repo path ${repoPath}`);
  }

  const next = {
    ...group,
    repos: [
      ...group.repos,
      {
        name: options.name,
        path: repoPath,
        taskId: options.taskId
      }
    ],
    updatedAt: new Date().toISOString()
  };
  writeGroup(paths, next);
  return next;
}

export function listGroups(paths: DevtaskPaths): TaskGroup[] {
  if (!fs.existsSync(paths.groupsDir)) {
    return [];
  }

  return fs
    .readdirSync(paths.groupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => getGroup(paths, entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getGroup(paths: DevtaskPaths, id: string): TaskGroup {
  assertValidTaskId(id);
  const filePath = groupJsonPath(paths, id);
  if (!fs.existsSync(filePath)) {
    throw new DevtaskError(`Group ${id} does not exist`);
  }

  return parseGroup(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

export function groupDir(paths: DevtaskPaths, id: string): string {
  return path.join(paths.groupsDir, id);
}

function groupJsonPath(paths: DevtaskPaths, id: string): string {
  return path.join(groupDir(paths, id), "group.json");
}

function writeGroup(paths: DevtaskPaths, group: TaskGroup): void {
  fs.writeFileSync(groupJsonPath(paths, group.id), `${JSON.stringify(group, null, 2)}\n`);
}

function parseGroup(value: unknown): TaskGroup {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new DevtaskError("Invalid group metadata");
  }

  const id = requireString(value, "id");
  return {
    schemaVersion: 1,
    id,
    goal: value.goal === null || value.goal === undefined ? null : requireString(value, "goal"),
    repos: parseRepos(value.repos),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt")
  };
}

function parseRepos(value: unknown): TaskGroupRepo[] {
  if (!Array.isArray(value)) {
    throw new DevtaskError("Invalid group metadata: repos must be an array");
  }

  return value.map((repo) => {
    if (!isRecord(repo)) {
      throw new DevtaskError("Invalid group metadata: repo must be an object");
    }

    return {
      name: requireString(repo, "name"),
      path: requireString(repo, "path"),
      taskId: requireString(repo, "taskId")
    };
  });
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid group metadata: ${field} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidRepoName(name: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new DevtaskError("Repo name may only contain letters, numbers, dots, underscores, and dashes");
  }
}
