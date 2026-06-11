import fs from "node:fs";
import path from "node:path";

export type PhaseRunPhase = "spec" | "plan" | "repo-plan" | "review" | "execute" | "compound";

export interface PhaseRunSessionMetadata {
  transportSessionId: string | null;
  threadId: string | null;
  agentSessionId: string | null;
  summary: string | null;
  summaryIsFallback: boolean | null;
}

export interface PhaseRunRecord {
  schemaVersion: 1;
  phase: PhaseRunPhase;
  runId: string;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: string;
  promptPath: string;
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  session: PhaseRunSessionMetadata;
  artifacts: Record<string, string>;
  exitCode: number | null;
}

export function emptyPhaseRunSessionMetadata(): PhaseRunSessionMetadata {
  return {
    transportSessionId: null,
    threadId: null,
    agentSessionId: null,
    summary: null,
    summaryIsFallback: null
  };
}

export function writePhaseRunRecord(dir: string, record: PhaseRunRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${record.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

export function readLatestPhaseRunRecord(dir: string): PhaseRunRecord | null {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const latest = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1);

  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as PhaseRunRecord;
}
