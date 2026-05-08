import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, taskDir, taskMetaPath } from "./paths.js";
import { buildCodexCommand } from "./config.js";
import { newRunId } from "./run-record.js";
import { runCommand } from "./process-runner.js";
import { readTaskMeta, writeTaskMeta } from "./meta.js";
import type { TaskMeta } from "./types.js";

export interface PlanRecord {
  schemaVersion: 1;
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
}

export interface PlanAgentStart {
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
}

export async function runPlanAgent(
  paths: DevtaskPaths,
  meta: TaskMeta,
  options: {
    model?: string | null;
    fullAuto?: boolean;
    onStart?: (start: PlanAgentStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }
): Promise<PlanRecord> {
  const planId = newRunId();
  const plansDir = path.join(taskDir(paths, meta.id), "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const promptPath = path.join(plansDir, `${planId}.prompt.md`);
  const outputPath = path.join(plansDir, `${planId}.md`);
  const planPath = planMarkdownPath(paths, meta.id);
  const prompt = buildPlanPrompt(meta, planPath);
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const beforeStatus = await readGitStatus(meta.worktreePath);
  const command = buildCodexCommand({ model: options.model, fullAuto: options.fullAuto });
  options.onStart?.({ command, outputPath, promptPath, planPath });
  const startedAt = new Date().toISOString();
  const output = fs.createWriteStream(outputPath, { flags: "w" });
  const result = await runCommand("sh", ["-c", command], {
    cwd: meta.worktreePath,
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: taskDir(paths, meta.id),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_PLAN_PATH: planPath,
      DEVTASK_STATE_PATH: meta.statePath,
      DEVTASK_RESULT_PATH: meta.resultPath
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
  const afterStatus = await readGitStatus(meta.worktreePath);
  const worktreeChanged = beforeStatus !== afterStatus;
  const planContent = readTextIfExists(planPath).trim();
  const resultStatus = readResultStatus(meta.resultPath);
  const status =
    result.exitCode !== 0 || worktreeChanged || !planContent
      ? "failed"
      : resultStatus === "blocked"
        ? "blocked"
        : "planned";

  const record: PlanRecord = {
    schemaVersion: 1,
    planId,
    taskId: meta.id,
    status,
    command,
    promptPath,
    outputPath,
    planPath,
    startedAt,
    finishedAt,
    exitCode: result.exitCode,
    worktreeChanged
  };

  fs.writeFileSync(path.join(plansDir, `${planId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeTaskMeta(taskMetaPath(paths, meta.id), {
    ...readTaskMeta(taskMetaPath(paths, meta.id)),
    status,
    updatedAt: finishedAt
  });
  return record;
}

export function readLatestPlan(paths: DevtaskPaths, id: string): PlanRecord | null {
  const plansDir = path.join(taskDir(paths, id), "plans");
  if (!fs.existsSync(plansDir)) {
    return null;
  }

  const files = fs
    .readdirSync(plansDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const latest = files.at(-1);
  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(plansDir, latest), "utf8")) as PlanRecord;
}

export function hasTaskPlan(paths: DevtaskPaths, id: string): boolean {
  return readTextIfExists(planMarkdownPath(paths, id)).trim().length > 0;
}

export function buildPlanPromptForTest(meta: TaskMeta, planPath: string): string {
  return buildPlanPrompt(meta, planPath);
}

function buildPlanPrompt(meta: TaskMeta, planPath: string): string {
  const task = readTextIfExists(meta.taskPath).trim();
  const state = readTextIfExists(meta.statePath).trim();
  return [
    `Plan task ${meta.id}.`,
    "",
    "You are in the devtask planning stage.",
    "",
    "Task:",
    "",
    task || "(task file is empty)",
    "",
    "Current state:",
    "",
    state || "(state file is empty)",
    "",
    "Goal:",
    "Create an implementation plan only. Do not modify source code, tests, docs, config, package files, generated files, git state, or any other repository file.",
    `The only file you may write is the devtask plan artifact: ${planPath}.`,
    "",
    "Before writing the plan:",
    "- Inspect the repository structure.",
    "- Read the task and current state.",
    "- Read relevant files needed to understand existing patterns.",
    "- Prefer local conventions over new abstractions.",
    "- Do not invent requirements that are not present in the task.",
    "",
    "Write the plan with these Markdown sections:",
    "1. Summary",
    "2. Task Inputs",
    "3. Relevant Existing Files",
    "4. Current Behavior / Current Structure",
    "5. Proposed Changes",
    "6. Step-by-Step Implementation Plan",
    "7. Tests / Checks",
    "8. Risks and Assumptions",
    "9. Out of Scope",
    "10. Open Questions or Blockers",
    "",
    "Planning rules:",
    "- Every implementation step must name the expected files, modules, or areas it will touch.",
    "- Mark assumptions explicitly.",
    "- Keep the plan scoped to the task goal.",
    "- Do not include code patches unless a small interface sketch is necessary to remove ambiguity.",
    "- Make the plan precise enough that another agent can implement it without re-discovering the whole task.",
    "",
    "If the task is blocked, write a short blocked plan and set result.json to {\"status\":\"blocked\",\"reason\":\"...\"}.",
    "Otherwise, leave result.json as pending and ensure the plan file is complete."
  ].join("\n");
}

async function readGitStatus(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["status", "--porcelain"], { cwd: worktreePath });
  return result.stdout;
}

function readResultStatus(resultPath: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown };
    return typeof value.status === "string" ? value.status : null;
  } catch {
    return null;
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
