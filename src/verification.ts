import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { taskDir } from "./paths.js";
import { newRunId } from "./run-record.js";
import { runCommand } from "./process-runner.js";
import type { TaskMeta } from "./types.js";

export interface VerifyStepRecord {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface VerificationRecord {
  schemaVersion: 1;
  verificationId: string;
  taskId: string;
  status: "passed" | "failed";
  cwd: string;
  startedAt: string;
  finishedAt: string;
  steps: VerifyStepRecord[];
}

export async function runVerification(
  paths: DevtaskPaths,
  meta: TaskMeta,
  commands: string[]
): Promise<VerificationRecord> {
  const startedAt = new Date().toISOString();
  const steps: VerifyStepRecord[] = [];

  for (const command of commands) {
    const result = await runCommand("sh", ["-c", command], { cwd: meta.worktreePath });
    steps.push({
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    });

    if (result.exitCode !== 0) {
      break;
    }
  }

  const record: VerificationRecord = {
    schemaVersion: 1,
    verificationId: newRunId(),
    taskId: meta.id,
    status: steps.every((step) => step.exitCode === 0) ? "passed" : "failed",
    cwd: meta.worktreePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps
  };

  writeVerificationRecord(paths, meta.id, record);
  return record;
}

export function readLatestVerification(paths: DevtaskPaths, id: string): VerificationRecord | null {
  const dir = verificationDir(paths, id);
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const latest = files.at(-1);
  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as VerificationRecord;
}

function writeVerificationRecord(paths: DevtaskPaths, id: string, record: VerificationRecord): void {
  const dir = verificationDir(paths, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.verificationId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function verificationDir(paths: DevtaskPaths, id: string): string {
  return path.join(taskDir(paths, id), "verifications");
}
