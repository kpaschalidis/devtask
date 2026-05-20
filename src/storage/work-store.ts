import fs from "node:fs";
import path from "node:path";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { workItemDir, workItemJsonPath, workItemSourcePath, workItemStatePath } from "../infra/paths.js";

export type WorkItemStatus = "created";

export type WorkItemSource =
  | {
      type: "manual";
      title: string;
      artifact: string;
    }
  | {
      type: "jira";
      key: string;
      title: string;
      url: string;
      artifact: string;
    };

export interface WorkItem {
  schemaVersion: 1;
  id: string;
  status: WorkItemStatus;
  source: WorkItemSource;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManualWorkItemOptions {
  id: string;
  title: string;
  body?: string | null;
}

export interface CreateJiraWorkItemOptions {
  id: string;
  key: string;
  title: string;
  url: string;
  artifact: string;
}

export function createManualWorkItem(paths: DevtaskPaths, options: CreateManualWorkItemOptions): WorkItem {
  assertValidWorkItemId(options.id);
  const title = requireNonEmpty(options.title, "work item title");
  const dir = prepareWorkItemDir(paths, options.id);
  const sourcePath = workItemSourcePath(paths, options.id);
  fs.writeFileSync(sourcePath, renderManualSource(options.id, title, options.body));
  return writeNewWorkItem(paths, {
    id: options.id,
    source: {
      type: "manual",
      title,
      artifact: sourcePath
    },
    dir
  });
}

export function createJiraWorkItem(paths: DevtaskPaths, options: CreateJiraWorkItemOptions): WorkItem {
  assertValidWorkItemId(options.id);
  const dir = prepareWorkItemDir(paths, options.id);
  return writeNewWorkItem(paths, {
    id: options.id,
    source: {
      type: "jira",
      key: requireNonEmpty(options.key, "Jira issue key"),
      title: requireNonEmpty(options.title, "Jira issue title"),
      url: requireNonEmpty(options.url, "Jira issue URL"),
      artifact: requireExistingFile(options.artifact, "Jira source artifact")
    },
    dir
  });
}

export function getWorkItem(paths: DevtaskPaths, id: string): WorkItem {
  assertValidWorkItemId(id);
  const filePath = workItemJsonPath(paths, id);
  if (!fs.existsSync(filePath)) {
    throw new DevtaskError(`Work item ${id} does not exist`);
  }
  return parseWorkItem(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

export function listWorkItems(paths: DevtaskPaths): WorkItem[] {
  if (!fs.existsSync(paths.workDir)) {
    return [];
  }

  return fs
    .readdirSync(paths.workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => getWorkItem(paths, entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function prepareWorkItemDir(paths: DevtaskPaths, id: string): string {
  const dir = workItemDir(paths, id);
  const filePath = workItemJsonPath(paths, id);
  if (fs.existsSync(filePath)) {
    throw new DevtaskError(`Work item ${id} already exists`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNewWorkItem(paths: DevtaskPaths, options: { id: string; source: WorkItemSource; dir: string }): WorkItem {
  const now = new Date().toISOString();
  const item: WorkItem = {
    schemaVersion: 1,
    id: options.id,
    status: "created",
    source: options.source,
    createdAt: now,
    updatedAt: now
  };
  fs.writeFileSync(workItemJsonPath(paths, options.id), `${JSON.stringify(item, null, 2)}\n`);
  fs.writeFileSync(workItemStatePath(paths, options.id), `# State: ${options.id}\n\n## Progress\n- Created ${now}\n`);
  return item;
}

function parseWorkItem(value: unknown): WorkItem {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new DevtaskError("Invalid work item metadata");
  }

  const id = requireString(value, "id");
  assertValidWorkItemId(id);
  const status = requireString(value, "status");
  if (status !== "created") {
    throw new DevtaskError(`Invalid work item metadata: unsupported status ${status}`);
  }

  return {
    schemaVersion: 1,
    id,
    status,
    source: parseWorkItemSource(value.source),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt")
  };
}

function parseWorkItemSource(value: unknown): WorkItemSource {
  if (!isRecord(value)) {
    throw new DevtaskError("Invalid work item metadata: source must be an object");
  }

  const type = requireString(value, "type");
  if (type === "manual") {
    return {
      type,
      title: requireString(value, "title"),
      artifact: requireExistingFile(requireString(value, "artifact"), "work item source artifact")
    };
  }
  if (type === "jira") {
    return {
      type,
      key: requireString(value, "key"),
      title: requireString(value, "title"),
      url: requireString(value, "url"),
      artifact: requireExistingFile(requireString(value, "artifact"), "Jira source artifact")
    };
  }

  throw new DevtaskError(`Invalid work item metadata: unsupported source type ${type}`);
}

function renderManualSource(id: string, title: string, body: string | null | undefined): string {
  return [`# ${id}: ${title}`, "", "## Description", "", body?.trim() || "-", ""].join("\n");
}

function requireExistingFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new DevtaskError(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DevtaskError(`${label} is required`);
  }
  return trimmed;
}

function assertValidWorkItemId(id: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new DevtaskError("Work item id may only contain letters, numbers, dots, underscores, and dashes");
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new DevtaskError(`Invalid work item metadata: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
