import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../infra/config.js";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  phaseRunDir,
  workItemDir,
  workItemLearningsPath,
  workItemRepoPlansDir,
  workItemResultsDir,
  workItemReviewDir,
  workItemValidationContractPath,
} from "../infra/paths.js";
import { writePhaseRunRecord } from "../infra/session-run.js";
import { newRunId } from "../infra/run-record.js";
import { getWorkItem, updateWorkItemStatus } from "../storage/work-store.js";
import { updateRecentWork } from "../storage/global-index.js";
import { buildCompoundPrompt } from "../prompts/compound.js";
import { runWorkAgentPrompt } from "./agent-prompt-service.js";
import { writeWorkResult } from "./work-result-service.js";

export interface CompoundWorkResult {
  workId: string;
  status: "completed" | "failed";
  promptPath: string;
  outputPath: string;
  learningsPath: string;
  generatedAt: string;
}

export async function compoundWork(paths: DevtaskPaths, workId: string): Promise<CompoundWorkResult> {
  const config = readConfig(paths);
  const item = getWorkItem(paths, workId);
  const runsDir = phaseRunDir(paths, workId, "compound", null);
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = newRunId();
  const promptPath = path.join(runsDir, `${runId}.prompt.md`);
  const outputPath = path.join(runsDir, `${runId}.md`);
  const learningsPath = workItemLearningsPath(paths, workId);
  const specFile = path.join(paths.workDir, workId, "spec.md");
  const specPath = fs.existsSync(specFile) ? specFile : null;
  const contractFile = workItemValidationContractPath(paths, workId);
  const contractPath = fs.existsSync(contractFile) ? contractFile : null;
  const planPath = fs.existsSync(path.join(paths.workDir, workId, "plan.md")) ? path.join(paths.workDir, workId, "plan.md") : null;
  const graphPath = fs.existsSync(path.join(paths.workDir, workId, "graph.json")) ? path.join(paths.workDir, workId, "graph.json") : null;
  const prompt = buildCompoundPrompt({
    workId,
    sourcePath: item.source.artifact,
    specPath,
    contractPath,
    planPath,
    graphPath,
    repoPlansDir: workItemRepoPlansDir(paths, workId),
    resultsDir: workItemResultsDir(paths, workId),
    reviewsDir: workItemReviewDir(paths, workId),
    learningsPath
  });
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const startedAt = new Date().toISOString();
  const result = await runWorkAgentPrompt(
    config,
    {
      workspacePath: paths.root,
      model: config.codex.model,
      fullAuto: config.codex.fullAuto,
      skipGitRepoCheck: true,
      addDirs: [workItemDir(paths, workId)],
      env: {
        ...process.env,
        DEVTASK_TASK_DIR: workItemDir(paths, workId),
        DEVTASK_TASK_PATH: promptPath
      }
    },
    prompt,
    { outputPath }
  );
  const finishedAt = new Date().toISOString();
  const status: CompoundWorkResult["status"] =
    result.status === "completed" && isFreshNonEmptyFile(learningsPath, startedAt) ? "completed" : "failed";
  writePhaseRunRecord(phaseRunDir(paths, workId, "compound", null), {
    schemaVersion: 1,
    phase: "compound",
    runId,
    workId,
    repoId: null,
    taskId: null,
    status,
    promptPath,
    outputPath,
    startedAt,
    finishedAt,
    session: result.session,
    artifacts: {
      learningsPath
    },
    exitCode: status === "completed" ? 0 : null
  });
  const compoundResult: CompoundWorkResult = {
    workId,
    status,
    promptPath,
    outputPath,
    learningsPath,
    generatedAt: finishedAt
  };
  writeWorkResult(paths, workId, "compound", compoundResult);
  if (compoundResult.status === "completed") {
    updateWorkItemStatus(paths, workId, "completed");
  }
  await updateRecentWork(paths, item);
  return compoundResult;
}

function isFreshNonEmptyFile(filePath: string, startedAt: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf8").trim().length > 0 &&
      fs.statSync(filePath).mtimeMs >= Date.parse(startedAt);
  } catch {
    return false;
  }
}
