import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  workItemDir,
  workItemResultsDir,
  workItemSpecPath
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/phase-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { buildSpecPrompt } from "../prompts/spec-plan.js";
import { getWorkItem } from "../storage/work-item.js";
import {
  launchPhaseFresh,
  launchPhaseResume,
  readPreviousSession,
  buildFeedbackPrompt,
  killLiveSession,
  attachTmuxSession
} from "./runner.js";
import type { PhaseConfig, PhaseFreshScope, PhaseScope } from "./types.js";

export const specPhase: PhaseConfig = {
  resumeScope(paths, workId, _repoId, runId): PhaseScope {
    const runsDir = phaseRunDir(paths, workId, "spec", null);
    const specPath = workItemSpecPath(paths, workId);
    return {
      tmuxSession: tmuxSessionName(paths, `spec-${workId}`),
      cwd: paths.root,
      promptPath: path.join(runsDir, `${runId}.prompt.md`),
      outputPath: path.join(runsDir, `${runId}.md`),
      taskId: null,
      artifacts: { specPath }
    };
  },

  async freshScope(paths, workId, _repoId, runId): Promise<PhaseFreshScope> {
    const item = getWorkItem(paths, workId);
    const config = readConfig(paths);
    const runsDir = phaseRunDir(paths, workId, "spec", null);
    const promptPath = path.join(runsDir, `${runId}.prompt.md`);
    const outputPath = path.join(runsDir, `${runId}.md`);
    const specPath = workItemSpecPath(paths, workId);
    return {
      scope: {
        tmuxSession: tmuxSessionName(paths, `spec-${workId}`),
        cwd: paths.root,
        promptPath,
        outputPath,
        taskId: null,
        artifacts: { specPath }
      },
      prompt: buildSpecPrompt(item, specPath),
      startOptions: {
        workspacePath: paths.root,
        model: config.codex.model,
        fullAuto: config.codex.fullAuto,
        skipGitRepoCheck: true,
        addDirs: [path.dirname(item.source.artifact)],
        env: {
          ...process.env,
          DEVTASK_TASK_DIR: workItemDir(paths, workId),
          DEVTASK_TASK_PATH: promptPath,
          DEVTASK_WORK_SPEC_PATH: specPath
        }
      }
    };
  },

  workspacePath(paths) {
    return paths.root;
  },

  async finalize(paths, workId, _repoId, sessionRecord, session, finishedAt) {
    const specPath = sessionRecord.artifacts.specPath ?? workItemSpecPath(paths, workId);
    const status = isFreshArtifactSince(specPath, sessionRecord.startedAt) ? "spec-ready" : "failed";
    const dir = workItemResultsDir(paths, workId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "spec.json"),
      `${JSON.stringify(
        {
          runId: sessionRecord.runId,
          workId,
          status,
          specPath,
          promptPath: sessionRecord.promptPath,
          outputPath: sessionRecord.outputPath,
          exitCode: status === "spec-ready" ? 0 : null,
          generatedAt: finishedAt,
          session
        },
        null,
        2
      )}\n`
    );
    return { status, artifacts: { specPath } };
  },

  async attach(paths, workId) {
    const dir = phaseRunDir(paths, workId, "spec", null);
    const current = readRunningPhaseRun(dir);
    if (current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "")) {
      attachTmuxSession(current.tmuxSession!);
      return;
    }
    const launched = await launchPhaseResume(specPhase, paths, workId, "spec", null);
    attachTmuxSession(launched.tmuxSession);
  },

  async sendFeedback(paths, workId, _repoId, message) {
    const previous = readPreviousSession(paths, workId, "spec", null);
    const prompt = buildFeedbackPrompt("spec", message, previous.session);
    return launchPhaseResume(specPhase, paths, workId, "spec", null, prompt, true);
  },

  reset(paths, workId) {
    killLiveSession(paths, workId, "spec", null);
    updateRunningPhaseRun(phaseRunDir(paths, workId, "spec", null), {
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
