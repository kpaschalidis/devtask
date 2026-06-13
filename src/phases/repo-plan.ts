import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  workItemDir,
  workItemRepoPlanPath,
  resolvePaths
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/phase-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { buildRepoPlanPrompt } from "../prompts/repo-plan.js";
import { readWorkGraph } from "../work-materializer.js";
import { getWorkspaceRepo } from "../storage/workspace-repos.js";
import type { WorkspaceRepo } from "../storage/workspace-repos.js";
import { getWorkItem } from "../storage/work-item.js";
import type { WorkItem } from "../storage/work-item.js";
import { DevtaskError } from "../infra/errors.js";
import {
  launchPhaseFresh,
  launchPhaseResume,
  readPreviousSession,
  buildFeedbackPrompt,
  killLiveSession,
  attachTmuxSession
} from "./runner.js";
import type { PhaseConfig, PhaseFreshScope, PhaseScope } from "./types.js";
import type { WorkGraphTask } from "../work-materializer.js";

export const repoPlanPhase: PhaseConfig = {
  resumeScope(paths, workId, repoId, runId): PhaseScope {
    if (!repoId) throw new DevtaskError("repo-plan resume requires a repo id");
    const graph = readWorkGraph(paths, workId);
    const graphTask = graph.tasks.find((t) => t.repoId === repoId);
    if (!graphTask) throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
    const repo = getWorkspaceRepo(paths, repoId);
    const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
    return {
      tmuxSession: tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`),
      cwd: repo.repoPath,
      promptPath: path.join(phaseDir, `${runId}.prompt.md`),
      outputPath: path.join(phaseDir, `${runId}.md`),
      taskId: graphTask.id,
      artifacts: { planPath: workItemRepoPlanPath(paths, workId, repoId) }
    };
  },

  async freshScope(paths, workId, repoId, runId): Promise<PhaseFreshScope> {
    if (!repoId) throw new DevtaskError("repo-plan requires a repo id");
    const graph = readWorkGraph(paths, workId);
    const graphTask = graph.tasks.find((t) => t.repoId === repoId);
    if (!graphTask) throw new DevtaskError(`No repo-plan task exists for ${workId}/${repoId}`);
    const repo = getWorkspaceRepo(paths, repoId);
    const item = getWorkItem(paths, workId);
    const config = readConfig(paths);
    const repoPaths = resolvePaths(repo.repoPath);
    const phaseDir = phaseRunDir(paths, workId, "repo-plan", repoId);
    const promptPath = path.join(phaseDir, `${runId}.prompt.md`);
    const outputPath = path.join(phaseDir, `${runId}.md`);
    const runtimePrefix = path.join(repoPaths.root, `.devtask_repo_plan_${runId}`);
    const runtimePlanPath = `${runtimePrefix}.md`;
    const runtimeStatePath = `${runtimePrefix}.state.md`;
    const resultPath = `${runtimePrefix}.result.json`;
    return {
      scope: {
        tmuxSession: tmuxSessionName(paths, `repo-plan-${workId}-${repoId}`),
        cwd: repo.repoPath,
        promptPath,
        outputPath,
        taskId: graphTask.id,
        artifacts: { planPath: workItemRepoPlanPath(paths, workId, repoId), runtimePlanPath, runtimeStatePath, resultPath }
      },
      prompt: buildRepoPlanPrompt(
        { id: graphTask.id },
        runtimePlanPath,
        workItemRepoPlanPath(paths, workId, repoId),
        buildRepoPlanTask(item, graphTask, repo),
        `# State: ${graphTask.id}\n\n## Progress\n- Repo-plan phase for work ${workId}\n`,
        collectPhaseMemory(paths, "planning", { repoId })
      ),
      startOptions: {
        workspacePath: repoPaths.root,
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
      }
    };
  },

  workspacePath(paths, _workId, repoId) {
    if (!repoId) throw new DevtaskError("repo-plan requires a repo id");
    return getWorkspaceRepo(paths, repoId).repoPath;
  },

  async finalize(paths, workId, repoId, sessionRecord) {
    if (!repoId) throw new DevtaskError("repo-plan finalizer requires a repo id");
    const planPath = sessionRecord.artifacts.planPath ?? workItemRepoPlanPath(paths, workId, repoId);
    const runtimePlanPath = sessionRecord.artifacts.runtimePlanPath;
    const runtimeStatePath = sessionRecord.artifacts.runtimeStatePath;
    const resultPath = sessionRecord.artifacts.resultPath;
    if (!runtimePlanPath || !runtimeStatePath || !resultPath) {
      throw new DevtaskError(`repo-plan session artifacts are incomplete for ${workId}/${repoId}`);
    }
    persistSharedRepoPlan(paths, workId, repoId, runtimePlanPath);
    const blocked = readResultStatus(resultPath) === "blocked";
    removeIfExists(runtimePlanPath);
    removeIfExists(runtimeStatePath);
    removeIfExists(resultPath);
    const status = isFreshArtifactSince(planPath, sessionRecord.startedAt)
      ? blocked ? "blocked" : "planned"
      : "failed";
    return { status, artifacts: { planPath } };
  },

  async attach(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("repo-plan attach requires a repo id");
    const dir = phaseRunDir(paths, workId, "repo-plan", repoId);
    const current = readRunningPhaseRun(dir);
    if (current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "")) {
      attachTmuxSession(current.tmuxSession!);
      return;
    }
    const launched = await launchPhaseResume(repoPlanPhase, paths, workId, "repo-plan", repoId);
    attachTmuxSession(launched.tmuxSession);
  },

  async sendFeedback(paths, workId, repoId, message) {
    if (!repoId) throw new DevtaskError("repo-plan feedback requires a repo id");
    const previous = readPreviousSession(paths, workId, "repo-plan", repoId);
    const prompt = buildFeedbackPrompt("repo-plan", message, previous.session);
    return launchPhaseResume(repoPlanPhase, paths, workId, "repo-plan", repoId, prompt, true);
  },

  reset(paths, workId, repoId) {
    if (!repoId) throw new DevtaskError("repo-plan reset requires a repo id");
    killLiveSession(paths, workId, "repo-plan", repoId);
    updateRunningPhaseRun(phaseRunDir(paths, workId, "repo-plan", repoId), {
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
  }
};

function buildRepoPlanTask(item: WorkItem, graphTask: WorkGraphTask, repo: WorkspaceRepo): string {
  return [
    `# Task ${graphTask.id}`,
    "",
    "## Goal",
    graphTask.goal,
    "",
    "## Work Item",
    `- id: ${item.id}`,
    `- title: ${item.source.title}`,
    `- source artifact: ${item.source.artifact}`,
    `- repo id: ${repo.id}`,
    `- repo path: ${repo.repoPath}`,
    `- repo scope: ${repo.scope ?? "."}`,
    "",
    "## Ownership",
    ...(graphTask.owns.length > 0 ? graphTask.owns.map((e) => `- ${e}`) : ["- none"]),
    "",
    "## Dependencies",
    ...(graphTask.dependencies.length > 0
      ? graphTask.dependencies.map((d) => `- ${d.task} (${d.type})${d.reason ? `: ${d.reason}` : ""}`)
      : ["- none"])
  ].join("\n");
}

function persistSharedRepoPlan(paths: DevtaskPaths, workId: string, repoId: string, sourcePlanPath: string): void {
  const plan = readTextIfExists(sourcePlanPath).trim();
  if (!plan) return;
  const target = workItemRepoPlanPath(paths, workId, repoId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${plan}\n`);
}

function readResultStatus(resultPath: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { status?: unknown };
    return typeof value.status === "string" ? value.status : "pending";
  } catch {
    return "pending";
  }
}

function isFreshArtifactSince(filePath: string, startedAt: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return false;
    return fs.statSync(filePath).mtimeMs >= Date.parse(startedAt);
  } catch {
    return false;
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
