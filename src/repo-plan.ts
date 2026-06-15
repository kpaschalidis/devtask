import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./infra/paths.js";
import { planMarkdownPath, phaseRunDir, taskDir, taskMetaPath } from "./infra/paths.js";
import { createDefaultAgentRunner, resumeAgentPrompt, runAgentPrompt } from "./agent.js";
import type { AgentSessionRef } from "./agent-session.js";
import { writePhaseRunRecord } from "./infra/session-run.js";
import { collectPhaseMemory } from "./improvement-memory.js";
import { newRunId } from "./infra/run-record.js";
import { runCommand } from "./infra/process-runner.js";
import { readTaskMeta, writeTaskMeta } from "./storage/meta.js";
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

export interface PlanAgentStart {
  command: string;
  promptPath: string;
  outputPath: string;
  planPath: string;
}

export async function runPlanAgent(
  paths: DevtaskPaths,
  meta: TaskMeta,
  context: {
    workspacePaths: DevtaskPaths;
    workId: string;
    repoId: string;
  },
  options: {
    model?: string | null;
    fullAuto?: boolean;
    onStart?: (start: PlanAgentStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    resumeSession?: AgentSessionRef | null;
    promptOverride?: string | null;
  }
): Promise<PlanRecord> {
  const planId = newRunId();
  const plansDir = path.join(taskDir(paths, meta.id), "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const promptPath = path.join(plansDir, `${planId}.prompt.md`);
  const outputPath = path.join(plansDir, `${planId}.md`);
  const planPath = planMarkdownPath(paths, meta.id);
  const runtimePlanPath = path.join(meta.worktreePath, ".devtask_plan.md");
  const runtimeStatePath = path.join(meta.worktreePath, ".devtask_plan_state.md");
  const runtimeResultPath = path.join(meta.worktreePath, ".devtask_plan_result.json");
  removeIfExists(runtimePlanPath);
  removeIfExists(runtimeStatePath);
  removeIfExists(runtimeResultPath);
  const task = readTextIfExists(meta.taskPath).trim();
  const state = readTextIfExists(meta.statePath).trim();
  const memory = collectPhaseMemory(context.workspacePaths, "planning", { repoId: context.repoId });
  const prompt = options.promptOverride?.trim()
    ? options.promptOverride.trim()
    : loadInstruction("repo-plan", {
        TASK_ID: meta.id,
        TASK_CONTENT: task || "(task file is empty)",
        STATE_CONTENT: state || "(state file is empty)",
        PLAN_PATH: runtimePlanPath,
        MEMORY: memory ? `${memory}\n\n` : ""
      });
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const beforeStatus = await readGitStatus(meta.worktreePath);
  const runner = createDefaultAgentRunner({
    schemaVersion: 1,
    tracker: { provider: null },
    scm: { provider: null },
    agent: { provider: "codex" },
    agentSessions: {
      roots: {
        codex: null,
        cursor: null
      }
    },
    codex: { model: options.model ?? null, fullAuto: options.fullAuto !== false },
    runtime: { mode: "attachable", backend: "tmux" },
    runtimeConfigured: false,
    jira: { baseUrl: null, email: null, cloudId: null },
    verify: []
  });
  const startOptions = {
    workspacePath: meta.worktreePath,
    model: options.model,
    fullAuto: options.fullAuto,
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: taskDir(paths, meta.id),
      DEVTASK_TASK_PATH: promptPath,
      DEVTASK_PLAN_PATH: runtimePlanPath,
      DEVTASK_STATE_PATH: runtimeStatePath,
      DEVTASK_RESULT_PATH: runtimeResultPath
    }
  } as const;
  const command = options.resumeSession
    ? (runner.buildResumeCommand?.(options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }) ?? "agent-resume")
    : (runner.buildStartCommand?.(startOptions) ?? "agent-run");
  options.onStart?.({ command, outputPath, promptPath, planPath });
  const startedAt = new Date().toISOString();
  const result = options.resumeSession
    ? await resumeAgentPrompt(runner, options.resumeSession, {
        workspacePath: startOptions.workspacePath,
        model: startOptions.model ?? null,
        prompt
      }, prompt, {
        outputPath,
        onOutput: (chunk) => {
          options.onStdout?.(chunk);
        }
      })
    : await runAgentPrompt(runner, startOptions, prompt, {
        outputPath,
        onOutput: (chunk) => {
          options.onStdout?.(chunk);
        }
      });
  const finishedAt = new Date().toISOString();
  persistRuntimePlan(runtimePlanPath, planPath);
  persistRuntimeResult(runtimeResultPath, meta.resultPath);
  removeIfExists(runtimePlanPath);
  removeIfExists(runtimeStatePath);
  removeIfExists(runtimeResultPath);
  const afterStatus = await readGitStatus(meta.worktreePath);
  const worktreeChanged = beforeStatus !== afterStatus;
  const planContent = readTextIfExists(planPath).trim();
  const resultStatus = readResultStatus(meta.resultPath);
  const status =
    result.status !== "completed" || worktreeChanged || !planContent
      ? "failed"
      : resultStatus === "blocked"
        ? "blocked"
        : "planned";

  const record: PlanRecord = {
    schemaVersion: 1,
    phase: "repo-plan",
    planId,
    taskId: meta.id,
    status,
    command,
    promptPath,
    outputPath,
    planPath,
    startedAt,
    finishedAt,
    exitCode: result.status === "completed" ? 0 : null,
    worktreeChanged,
    session: result.session
  };

  fs.writeFileSync(path.join(plansDir, `${planId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writePhaseRunRecord(phaseRunDir(context.workspacePaths, context.workId, "repo-plan", context.repoId), {
    schemaVersion: 1,
    phase: "repo-plan",
    runId: planId,
    workId: context.workId,
    repoId: context.repoId,
    taskId: meta.id,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      planPath
    },
    exitCode: result.status === "completed" ? 0 : null
  });
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

export function buildPlanPromptForTest(
  meta: TaskMeta,
  writablePlanPath: string,
  _finalPlanPath = writablePlanPath
): string {
  const task = readTextIfExists(meta.taskPath).trim();
  const state = readTextIfExists(meta.statePath).trim();
  return loadInstruction("repo-plan", {
    TASK_ID: meta.id,
    TASK_CONTENT: task || "(task file is empty)",
    STATE_CONTENT: state || "(state file is empty)",
    PLAN_PATH: writablePlanPath,
    MEMORY: ""
  });
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

function persistRuntimePlan(runtimePlanPath: string, planPath: string): void {
  const plan = readTextIfExists(runtimePlanPath);
  if (!plan.trim()) {
    return;
  }

  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, plan.endsWith("\n") ? plan : `${plan}\n`);
}

function persistRuntimeResult(runtimeResultPath: string, resultPath: string): void {
  if (!fs.existsSync(runtimeResultPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.copyFileSync(runtimeResultPath, resultPath);
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
