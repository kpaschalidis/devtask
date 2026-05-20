import fs from "node:fs";
import path from "node:path";

export type RunStatus = "success" | "failed" | "cancelled";

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  status: RunStatus;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function writeRunRecord(runsDir: string, record: RunRecord): string {
  fs.mkdirSync(runsDir, { recursive: true });
  const filePath = path.join(runsDir, `${record.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}
