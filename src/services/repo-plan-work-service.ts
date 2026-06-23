import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir, workItemDir, workItemRepoContextPath, workItemRepoPlanPath } from "../infra/paths.js";
import { writePhaseRunRecord } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import { DevtaskError } from "../infra/errors.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { loadInstruction } from "../instructions/loader.js";
import { getWorkspaceRepo } from "../storage/workspace-repos.js";
import { readWorkGraph, type WorkGraphTask } from "../work-materializer.js";
import type { WorkspaceRepo } from "../storage/workspace-repos.js";
import { runWorkAgentPrompt } from "./agent-prompt-service.js";

export async function runRepoPlanWorker(paths: DevtaskPaths, workId: string, repoId: string): Promise<void> {
  const config = readConfig(paths);
  const graph = readWorkGraph(paths, workId);
  const graphTask = graph.tasks.find((task) => task.repoId === repoId);
  if (!graphTask) {
    throw new DevtaskError(`No task found in graph for repo ${repoId} in work item ${workId}`);
  }
  const repo = getWorkspaceRepo(paths, repoId);
  const runId = newRunId();
  const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
  fs.mkdirSync(phaseDir, { recursive: true });
  const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
  const outputPath = path.join(phaseDir, `${runId}.md`);
  const runtimePrefix = path.join(repo.repoPath, `.devtask_repo_plan_${runId}`);
  const runtimePlanPath = `${runtimePrefix}.md`;
  const runtimeStatePath = `${runtimePrefix}.state.md`;
  const resultPath = `${runtimePrefix}.result.json`;
  const finalPlanPath = workItemRepoPlanPath(paths, workId, repoId);
  const task = buildWorkerTaskDescription(workId, graphTask, repo);
  const state = `# State: ${graphTask.id}\n\n## Progress\n- Repo-plan phase for work ${workId}\n`;
  const memory = collectPhaseMemory(paths, "planning", { repoId });
  const contextPath = workItemRepoContextPath(paths, workId, repoId);
  const contextContent = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, "utf8").trim() : null;
  const prompt = loadInstruction("repo-plan", {
    TASK_ID: graphTask.id,
    TASK_CONTENT: task,
    STATE_CONTENT: state,
    PLAN_PATH: runtimePlanPath,
    CONTEXT: contextContent ? `## Orchestrator Context\n\n${contextContent}\n\n` : "",
    MEMORY: memory ? `${memory}\n\n` : ""
  });
  fs.writeFileSync(promptPath, `${prompt}\n`);
  const startedAt = new Date().toISOString();
  const result = await runWorkAgentPrompt(
    config,
    {
      workspacePath: repo.repoPath,
      model: config.codex.model,
      fullAuto: config.codex.fullAuto,
      skipGitRepoCheck: true,
      addDirs: [workItemDir(paths, workId), repo.scope ? path.join(repo.repoPath, repo.scope) : repo.repoPath],
      env: {
        ...process.env,
        DEVTASK_TASK_DIR: workItemDir(paths, workId),
        DEVTASK_TASK_PATH: promptPath,
        DEVTASK_PLAN_PATH: runtimePlanPath,
        DEVTASK_STATE_PATH: runtimeStatePath,
        DEVTASK_RESULT_PATH: resultPath
      }
    },
    prompt,
    { outputPath }
  );
  const finishedAt = new Date().toISOString();
  persistSharedRepoPlan(runtimePlanPath, finalPlanPath);
  const blocked = readResultStatus(resultPath) === "blocked";
  removeIfExists(runtimePlanPath);
  removeIfExists(runtimeStatePath);
  removeIfExists(resultPath);
  const planExists = fs.existsSync(finalPlanPath) && fs.readFileSync(finalPlanPath, "utf8").trim().length > 0;
  const status = planExists ? (blocked ? "blocked" : "planned") : "failed";
  writePhaseRunRecord(phaseDir, {
    schemaVersion: 1,
    phase: "repo-plan",
    runId,
    workId,
    repoId,
    taskId: graphTask.id,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: { planPath: finalPlanPath },
    exitCode: status !== "failed" ? 0 : null
  });
  if (status === "failed") {
    throw new DevtaskError(`Repo-plan worker failed for ${repoId}`);
  }
}

function buildWorkerTaskDescription(workId: string, graphTask: WorkGraphTask, repo: WorkspaceRepo): string {
  return [
    `# Task ${graphTask.id}`,
    "",
    "## Goal",
    graphTask.goal,
    "",
    "## Work Item",
    `- id: ${workId}`,
    `- repo id: ${repo.id}`,
    `- repo path: ${repo.repoPath}`,
    `- repo scope: ${repo.scope ?? "."}`,
    "",
    "## Ownership",
    ...(graphTask.owns.length > 0 ? graphTask.owns.map((entry) => `- ${entry}`) : ["- none"]),
    "",
    "## Dependencies",
    ...(graphTask.dependencies.length > 0
      ? graphTask.dependencies.map((dependency) => `- ${dependency.task} (${dependency.type})${dependency.reason != null ? `: ${dependency.reason}` : ""}`)
      : ["- none"])
  ].join("\n");
}

function persistSharedRepoPlan(runtimePlanPath: string, finalPlanPath: string): void {
  try {
    const plan = fs.readFileSync(runtimePlanPath, "utf8").trim();
    if (!plan) return;
    fs.mkdirSync(path.dirname(finalPlanPath), { recursive: true });
    fs.writeFileSync(finalPlanPath, `${plan}\n`);
  } catch {
    // no runtime plan to persist
  }
}

function readResultStatus(resultPath: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown };
    return typeof value.status === "string" ? value.status : "pending";
  } catch {
    return "pending";
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
