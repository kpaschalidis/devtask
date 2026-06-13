import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  workItemDir,
  workItemSpecPath
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/phase-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { collectPhaseMemory } from "../improvement-memory.js";
import { buildGlobalPlanPrompt } from "../prompts/global-plan.js";
import { workPlanAddDirsForTest } from "../global-plan.js";
import { listWorkspaceRepos } from "../storage/workspace-repos.js";
import { getWorkItem } from "../storage/work-item.js";
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

export const planPhase: PhaseConfig = {
  resumeScope(paths, workId, _repoId, runId): PhaseScope {
    const runsDir = phaseRunDir(paths, workId, "plan", null);
    return {
      tmuxSession: tmuxSessionName(paths, `plan-${workId}`),
      cwd: paths.root,
      promptPath: path.join(runsDir, `${runId}.prompt.md`),
      outputPath: path.join(runsDir, `${runId}.md`),
      taskId: null,
      artifacts: {
        planPath: path.join(workItemDir(paths, workId), "plan.md"),
        graphPath: path.join(workItemDir(paths, workId), "graph.json")
      }
    };
  },

  async freshScope(paths, workId, _repoId, runId): Promise<PhaseFreshScope> {
    const specPath = workItemSpecPath(paths, workId);
    if (!fs.existsSync(specPath) || fs.readFileSync(specPath, "utf8").trim().length === 0) {
      throw new DevtaskError(`Work spec is not ready for ${workId}. Run devtask work spec ${workId} first.`);
    }
    const item = getWorkItem(paths, workId);
    const config = readConfig(paths);
    const repos = listWorkspaceRepos(paths);
    const runsDir = phaseRunDir(paths, workId, "plan", null);
    const promptPath = path.join(runsDir, `${runId}.prompt.md`);
    const outputPath = path.join(runsDir, `${runId}.md`);
    const planPath = path.join(workItemDir(paths, workId), "plan.md");
    const graphPath = path.join(workItemDir(paths, workId), "graph.json");
    return {
      scope: {
        tmuxSession: tmuxSessionName(paths, `plan-${workId}`),
        cwd: paths.root,
        promptPath,
        outputPath,
        taskId: null,
        artifacts: { planPath, graphPath }
      },
      prompt: buildGlobalPlanPrompt(paths, item, repos, planPath, graphPath, specPath, collectPhaseMemory(paths, "planning")),
      startOptions: {
        workspacePath: paths.root,
        model: config.codex.model,
        fullAuto: config.codex.fullAuto,
        skipGitRepoCheck: true,
        addDirs: workPlanAddDirsForTest(item, repos),
        env: {
          ...process.env,
          DEVTASK_TASK_DIR: workItemDir(paths, workId),
          DEVTASK_TASK_PATH: promptPath,
          DEVTASK_WORK_PLAN_PATH: planPath,
          DEVTASK_WORK_GRAPH_PATH: graphPath
        }
      }
    };
  },

  workspacePath(paths) {
    return paths.root;
  },

  async finalize(paths, workId, _repoId, sessionRecord) {
    const planPath = sessionRecord.artifacts.planPath ?? path.join(workItemDir(paths, workId), "plan.md");
    const graphPath = sessionRecord.artifacts.graphPath ?? path.join(workItemDir(paths, workId), "graph.json");
    const status: "planned" | "failed" =
      isFreshArtifactSince(planPath, sessionRecord.startedAt) && isFreshGraphSince(graphPath, sessionRecord.startedAt)
        ? "planned"
        : "failed";
    return { status, artifacts: { planPath, graphPath } };
  },

  async attach(paths, workId) {
    const dir = phaseRunDir(paths, workId, "plan", null);
    const current = readRunningPhaseRun(dir);
    if (current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "")) {
      attachTmuxSession(current.tmuxSession!);
      return;
    }
    const launched = await launchPhaseResume(planPhase, paths, workId, "plan", null);
    attachTmuxSession(launched.tmuxSession);
  },

  async sendFeedback(paths, workId, _repoId, message) {
    const previous = readPreviousSession(paths, workId, "plan", null);
    const prompt = buildFeedbackPrompt("plan", message, previous.session);
    return launchPhaseResume(planPhase, paths, workId, "plan", null, prompt, true);
  },

  reset(paths, workId) {
    killLiveSession(paths, workId, "plan", null);
    updateRunningPhaseRun(phaseRunDir(paths, workId, "plan", null), {
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
  }
};

function isFreshArtifactSince(filePath: string, startedAt: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return false;
    return fs.statSync(filePath).mtimeMs >= Date.parse(startedAt);
  } catch {
    return false;
  }
}

function isFreshGraphSince(filePath: string, startedAt: string): boolean {
  if (!isFreshArtifactSince(filePath, startedAt)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: unknown; tasks?: unknown };
    return parsed.schemaVersion === 1 && Array.isArray(parsed.tasks);
  } catch {
    return false;
  }
}
