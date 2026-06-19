import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  workItemDir,
  workItemSpecPath,
  workItemValidationContractPath,
  workItemPlanPath,
  workItemGraphPath,
  workItemRepoPlanPath,
  workItemRepoContextPath,
  workItemResultsDir
} from "../infra/paths.js";
import { readRunningPhaseRun, updateRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists, tmuxSessionName } from "../infra/tmux.js";
import { loadInstruction } from "../instructions/loader.js";
import { copySkillsToDir } from "../skills/loader.js";
import { getWorkItem } from "../storage/work-item.js";
import {
  launchPhaseFresh,
  launchPhaseResume,
  readPreviousSession,
  buildFeedbackPrompt,
  killLiveSession,
  attachTmuxSession
} from "./runner.js";
import type { RoleConfig, RoleFreshScope, RoleScope, FreshScopeOpts } from "./types.js";

const ACCEPT_RECOMMENDED_PREAMBLE =
  "\nIn this session, --accept-recommended is active. Do not pause to ask the human for clarification at any point. When you encounter an ambiguity, apply your best judgment, state your assumption explicitly (e.g. \"Assuming X because Y\"), record it in the Clarifications section of the spec, and proceed. Keep the openQuestions array empty unless a worker explicitly surfaces a blocker you cannot resolve.\n";

export const orchestratorPhase: RoleConfig = {
  resumeScope(paths, workId, _repoId, runId): RoleScope {
    const runsDir = phaseRunDir(paths, workId, "orchestrate", null);
    return {
      tmuxSession: tmuxSessionName(paths, `orchestrate-${workId}`),
      cwd: paths.root,
      promptPath: path.join(runsDir, `${runId}.prompt.md`),
      outputPath: path.join(runsDir, `${runId}.md`),
      taskId: null,
      artifacts: {
        specPath: workItemSpecPath(paths, workId),
        contractPath: workItemValidationContractPath(paths, workId),
        planPath: workItemPlanPath(paths, workId),
        graphPath: workItemGraphPath(paths, workId)
      }
    };
  },

  async freshScope(paths, workId, _repoId, runId, opts?: FreshScopeOpts): Promise<RoleFreshScope> {
    copySkillsToDir(paths.root, ["branch", "pr"]);
    const item = getWorkItem(paths, workId);
    const config = readConfig(paths);
    const runsDir = phaseRunDir(paths, workId, "orchestrate", null);
    const promptPath = path.join(runsDir, `${runId}.prompt.md`);
    const outputPath = path.join(runsDir, `${runId}.md`);
    const specPath = workItemSpecPath(paths, workId);
    const contractPath = workItemValidationContractPath(paths, workId);
    const planPath = workItemPlanPath(paths, workId);
    const graphPath = workItemGraphPath(paths, workId);
    return {
      scope: {
        tmuxSession: tmuxSessionName(paths, `orchestrate-${workId}`),
        cwd: paths.root,
        promptPath,
        outputPath,
        taskId: null,
        artifacts: { specPath, contractPath, planPath, graphPath }
      },
      prompt: loadInstruction("orchestrator", {
        WORK_ID: workId,
        SOURCE_TYPE: item.source.type,
        SOURCE_TITLE: item.source.title,
        SOURCE_ARTIFACT: item.source.artifact,
        SOURCE_URL_LINE: "url" in item.source ? `- url: ${item.source.url}` : "",
        SPEC_PATH: specPath,
        CONTRACT_PATH: contractPath,
        PLAN_PATH: planPath,
        GRAPH_PATH: graphPath,
        ACCEPT_RECOMMENDED_PREAMBLE: opts?.acceptRecommended ? ACCEPT_RECOMMENDED_PREAMBLE : ""
      }),
      startOptions: {
        workspacePath: paths.root,
        model: config.codex.model,
        fullAuto: config.codex.fullAuto,
        skipGitRepoCheck: true,
        addDirs: [path.dirname(item.source.artifact), paths.root],
        env: {
          ...process.env,
          DEVTASK_TASK_DIR: workItemDir(paths, workId),
          DEVTASK_TASK_PATH: promptPath,
          DEVTASK_WORK_SPEC_PATH: specPath,
          DEVTASK_VALIDATION_CONTRACT_PATH: contractPath,
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
    const specPath = sessionRecord.artifacts.specPath ?? workItemSpecPath(paths, workId);
    const contractPath = sessionRecord.artifacts.contractPath ?? workItemValidationContractPath(paths, workId);
    const planPath = sessionRecord.artifacts.planPath ?? workItemPlanPath(paths, workId);
    const graphPath = sessionRecord.artifacts.graphPath ?? workItemGraphPath(paths, workId);

    const allFresh =
      isFreshArtifactSince(specPath, sessionRecord.startedAt) &&
      isFreshArtifactSince(contractPath, sessionRecord.startedAt) &&
      isFreshArtifactSince(planPath, sessionRecord.startedAt) &&
      isFreshValidGraph(graphPath, sessionRecord.startedAt) &&
      allRepoPlansFresh(paths, workId, graphPath, sessionRecord.startedAt);

    const status = allFresh ? "planned" : "failed";
    const dir = workItemResultsDir(paths, workId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "orchestrate.json"),
      `${JSON.stringify(
        {
          runId: sessionRecord.runId,
          workId,
          status,
          specPath,
          contractPath,
          planPath,
          graphPath,
          promptPath: sessionRecord.promptPath,
          outputPath: sessionRecord.outputPath,
          exitCode: status === "planned" ? 0 : null,
          generatedAt: new Date().toISOString(),
          session: sessionRecord.session
        },
        null,
        2
      )}\n`
    );
    return { status, artifacts: { specPath, contractPath, planPath, graphPath } };
  },

  async attach(paths, workId) {
    const dir = phaseRunDir(paths, workId, "orchestrate", null);
    const current = readRunningPhaseRun(dir);
    if (current?.status === "running" && tmuxSessionExists(current.tmuxSession ?? "")) {
      attachTmuxSession(current.tmuxSession!);
      return;
    }
    const launched = await launchPhaseResume(orchestratorPhase, paths, workId, "orchestrate", null);
    attachTmuxSession(launched.tmuxSession);
  },

  async sendFeedback(paths, workId, _repoId, message) {
    const previous = readPreviousSession(paths, workId, "orchestrate", null);
    const prompt = buildFeedbackPrompt("orchestrate", message, previous.session);
    return launchPhaseResume(orchestratorPhase, paths, workId, "orchestrate", null, prompt, true);
  },

  reset(paths, workId) {
    killLiveSession(paths, workId, "orchestrate", null);
    updateRunningPhaseRun(phaseRunDir(paths, workId, "orchestrate", null), {
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

function isFreshValidGraph(filePath: string, startedAt: string): boolean {
  if (!isFreshArtifactSince(filePath, startedAt)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: unknown; tasks?: unknown };
    return parsed.schemaVersion === 1 && Array.isArray(parsed.tasks);
  } catch {
    return false;
  }
}

function allRepoPlansFresh(paths: DevtaskPaths, workId: string, graphPath: string, startedAt: string): boolean {
  let graph: { tasks?: Array<{ repoId?: string }> };
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as typeof graph;
  } catch {
    return false;
  }
  const tasks = graph.tasks ?? [];
  if (tasks.length === 0) return true;
  return tasks.every((task) => {
    if (!task.repoId) return false;
    return (
      isFreshArtifactSince(workItemRepoPlanPath(paths, workId, task.repoId), startedAt) &&
      isFreshArtifactSince(workItemRepoContextPath(paths, workId, task.repoId), startedAt)
    );
  });
}
