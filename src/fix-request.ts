import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, taskDir } from "./paths.js";
import { DevtaskError } from "./errors.js";
import type { TaskMeta } from "./types.js";
import { newRunId } from "./run-record.js";
import { readLatestVerification, type VerificationRecord } from "./verification.js";

export const FIX_SOURCES = ["check", "review", "ci"] as const;
export type FixSource = (typeof FIX_SOURCES)[number];

export interface FixRequest {
  schemaVersion: 1;
  fixId: string;
  taskId: string;
  source: FixSource;
  summary: string;
  instructions: string;
  artifacts: string[];
  promptPath: string;
  createdAt: string;
}

export function createFixRequestFromCheck(paths: DevtaskPaths, meta: TaskMeta): FixRequest {
  const verification = readLatestVerification(paths, meta.id);
  if (!verification) {
    throw new DevtaskError(`Task ${meta.id} has no check result to fix.`);
  }
  if (verification.status !== "failed") {
    throw new DevtaskError(`Task ${meta.id} latest check is ${verification.status}; there is no failed check to fix.`);
  }

  const fixId = newRunId();
  const dir = fixDir(paths, meta.id);
  fs.mkdirSync(dir, { recursive: true });
  const promptPath = path.join(dir, `${fixId}.prompt.md`);
  const requestPath = path.join(dir, `${fixId}.json`);
  const request: FixRequest = {
    schemaVersion: 1,
    fixId,
    taskId: meta.id,
    source: "check",
    summary: summarizeFailedVerification(verification),
    instructions: [
      "Fix the task worktree so the failed check passes.",
      "Keep the accepted plan and task scope.",
      "Do not bypass, weaken, or remove tests unless the accepted plan is wrong and you explain why in state.",
      "Prefer the smallest production-quality correction.",
      "Commit the scoped fix when complete, then write {\"status\":\"done\"} to $DEVTASK_RESULT_PATH."
    ].join("\n"),
    artifacts: [verificationArtifactPath(paths, meta.id, verification.verificationId)],
    promptPath,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(promptPath, renderFixPrompt(paths, meta, request, verification));
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  fs.writeFileSync(activeFixRequestPath(paths, meta.id), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function readActiveFixRequest(paths: DevtaskPaths, taskId: string): FixRequest | null {
  const filePath = activeFixRequestPath(paths, taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return parseFixRequest(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

export function clearActiveFixRequest(paths: DevtaskPaths, taskId: string): void {
  const filePath = activeFixRequestPath(paths, taskId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function activeFixRequestPath(paths: DevtaskPaths, taskId: string): string {
  return path.join(fixDir(paths, taskId), "active.json");
}

function fixDir(paths: DevtaskPaths, taskId: string): string {
  return path.join(taskDir(paths, taskId), "fixes");
}

function verificationArtifactPath(paths: DevtaskPaths, taskId: string, verificationId: string): string {
  return path.join(taskDir(paths, taskId), "verifications", `${verificationId}.json`);
}

function summarizeFailedVerification(verification: VerificationRecord): string {
  const failed = verification.steps.find((step) => step.exitCode !== 0);
  return failed ? `Check failed: ${failed.command}` : "Check failed.";
}

function renderFixPrompt(paths: DevtaskPaths, meta: TaskMeta, request: FixRequest, verification: VerificationRecord): string {
  const plan = readTextIfExists(planMarkdownPath(paths, meta.id)).trim();
  return [
    `# Fix Request ${request.fixId}`,
    "",
    `Task: ${meta.id}`,
    `Source: ${request.source}`,
    `Summary: ${request.summary}`,
    "",
    "## Instructions",
    "",
    request.instructions,
    "",
    plan ? "## Accepted Plan" : "",
    plan,
    "",
    "## Failed Check",
    "",
    `Started: ${verification.startedAt}`,
    `Finished: ${verification.finishedAt}`,
    `Status: ${verification.status}`,
    "",
    ...verification.steps.flatMap((step, index) => [
      `### Step ${index + 1}: ${step.command}`,
      "",
      `Exit code: ${step.exitCode ?? "unknown"}`,
      "",
      step.stdout.trim() ? "#### stdout" : "",
      step.stdout.trim(),
      "",
      step.stderr.trim() ? "#### stderr" : "",
      step.stderr.trim(),
      ""
    ])
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trimEnd()
    .concat("\n");
}

function parseFixRequest(value: unknown): FixRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DevtaskError("Invalid fix request: expected an object");
  }
  const record = value as Partial<FixRequest>;
  if (record.schemaVersion !== 1) {
    throw new DevtaskError("Invalid fix request: schemaVersion must be 1");
  }
  if (!isFixSource(record.source)) {
    throw new DevtaskError("Invalid fix request: source is not recognized");
  }
  return {
    schemaVersion: 1,
    fixId: requireString(record, "fixId"),
    taskId: requireString(record, "taskId"),
    source: record.source,
    summary: requireString(record, "summary"),
    instructions: requireString(record, "instructions"),
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter((item): item is string => typeof item === "string") : [],
    promptPath: requireString(record, "promptPath"),
    createdAt: requireString(record, "createdAt")
  };
}

function isFixSource(value: unknown): value is FixSource {
  return value === "check" || value === "review" || value === "ci";
}

function requireString(record: Record<string, unknown>, field: keyof FixRequest): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DevtaskError(`Invalid fix request: ${String(field)} must be a string`);
  }
  return value;
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
