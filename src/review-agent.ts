import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { planMarkdownPath, taskDir } from "./paths.js";
import { buildCodexCommand } from "./config.js";
import { newRunId } from "./run-record.js";
import { runCommand } from "./process-runner.js";
import type { TaskMeta } from "./types.js";

export interface ReviewAgentRecord {
  schemaVersion: 1;
  reviewId: string;
  taskId: string;
  status: "passed" | "findings" | "failed";
  command: string;
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
}

export interface ReviewAgentStart {
  command: string;
  outputPath: string;
  promptPath: string;
}

export async function runReviewAgent(
  paths: DevtaskPaths,
  meta: TaskMeta,
  options: {
    model?: string | null;
    fullAuto?: boolean;
    onStart?: (start: ReviewAgentStart) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }
): Promise<ReviewAgentRecord> {
  const reviewId = newRunId();
  const reviewsDir = path.join(taskDir(paths, meta.id), "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });

  const promptPath = path.join(reviewsDir, `${reviewId}.prompt.md`);
  const outputPath = path.join(reviewsDir, `${reviewId}.md`);
  const plan = readTextIfExists(planMarkdownPath(paths, meta.id)).trim();
  const prompt = [
    `Review task ${meta.id}.`,
    "",
    "Act as a code reviewer. Do not modify files.",
    "Focus only on bugs, regressions, missing tests, unsafe assumptions, unnecessary files, and PR-blocking issues.",
    plan ? "Review whether the implementation matches the accepted plan." : "No accepted plan artifact exists for this task.",
    "If there are no blocking findings, say exactly: REVIEW PASSED",
    "",
    plan ? `Accepted plan:\n\n${plan}\n` : "",
    "Inspect the current worktree diff and relevant files before answering."
  ].join("\n");
  fs.writeFileSync(promptPath, `${prompt}\n`);

  const command = buildCodexCommand({ model: options.model, fullAuto: options.fullAuto });
  options.onStart?.({ command, outputPath, promptPath });
  const startedAt = new Date().toISOString();
  const output = fs.createWriteStream(outputPath, { flags: "w" });
  const result = await runCommand("sh", ["-c", command], {
    cwd: meta.worktreePath,
    env: {
      ...process.env,
      DEVTASK_TASK_DIR: taskDir(paths, meta.id),
      DEVTASK_TASK_PATH: promptPath
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
  const reviewOutput = readOutput(outputPath);

  const record: ReviewAgentRecord = {
    schemaVersion: 1,
    reviewId,
    taskId: meta.id,
    status: result.exitCode === 0 && reviewOutput.includes("REVIEW PASSED") ? "passed" : result.exitCode === 0 ? "findings" : "failed",
    command,
    outputPath,
    startedAt,
    finishedAt,
    exitCode: result.exitCode
  };

  fs.writeFileSync(path.join(reviewsDir, `${reviewId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readLatestReviewAgent(paths: DevtaskPaths, id: string): ReviewAgentRecord | null {
  const reviewsDir = path.join(taskDir(paths, id), "reviews");
  if (!fs.existsSync(reviewsDir)) {
    return null;
  }

  const files = fs
    .readdirSync(reviewsDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const latest = files.at(-1);
  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(reviewsDir, latest), "utf8")) as ReviewAgentRecord;
}

function readOutput(outputPath: string): string {
  try {
    return fs.readFileSync(outputPath, "utf8");
  } catch {
    return "";
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
