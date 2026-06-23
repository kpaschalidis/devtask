import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./infra/paths.js";
import { planMarkdownPath, taskDir } from "./infra/paths.js";
import type { AgentSessionRef } from "./infra/session-ref.js";
import type { TaskMeta } from "./types.js";
import { loadInstruction } from "./instructions/loader.js";

export interface PlanRecord {
  schemaVersion: 1;
  phase: "repo-plan";
  planId: string;
  taskId: string;
  status: "planned" | "blocked" | "failed";
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  worktreeChanged: boolean;
  session: AgentSessionRef;
}

export function readLatestPlan(paths: DevtaskPaths, id: string): PlanRecord | null {
  const plansDir = path.join(taskDir(paths, id), "plans");
  if (!fs.existsSync(plansDir)) {
    return null;
  }

  const latest = fs
    .readdirSync(plansDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1);

  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(plansDir, latest), "utf8")) as PlanRecord;
}

export function hasTaskPlan(paths: DevtaskPaths, id: string): boolean {
  return readTextIfExists(planMarkdownPath(paths, id)).trim().length > 0;
}

export function buildPlanPromptForTest(
  meta: TaskMeta,
  writablePlanPath: string,
  _finalPlanPath = writablePlanPath,
): string {
  const task = readTextIfExists(meta.taskPath).trim();
  const state = readTextIfExists(meta.statePath).trim();
  return loadInstruction("repo-plan", {
    TASK_ID: meta.id,
    TASK_CONTENT: task || "(task file is empty)",
    STATE_CONTENT: state || "(state file is empty)",
    PLAN_PATH: writablePlanPath,
    MEMORY: "",
  });
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
