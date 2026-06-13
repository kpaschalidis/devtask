import fs from "node:fs";
import path from "node:path";
import { emptyAgentSessionRef, type AgentSessionRef } from "../agent-session.js";

export type PhaseRunPhase = "spec" | "plan" | "repo-plan" | "review" | "execute" | "compound";

export type PhaseRunSessionMetadata = AgentSessionRef;

// Unified phase run — covers both live sessions and completed records.
// Live sessions are stored as running.json; completed ones as {runId}.json.
export interface PhaseRun {
  schemaVersion: 1;
  runId: string;
  phase: PhaseRunPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: string;
  tmuxSession: string | null;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: AgentSessionRef;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

// Backward-compat alias used by non-interactive phase run writers.
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
  return emptyAgentSessionRef();
}

// Write the running session marker (replaces session.json pattern).
export function writeRunningPhaseRun(
  dir: string,
  run: Omit<PhaseRun, "schemaVersion" | "status" | "updatedAt" | "finishedAt" | "exitCode"> & { tmuxSession: string }
): void {
  fs.mkdirSync(dir, { recursive: true });
  const record: PhaseRun = {
    schemaVersion: 1,
    status: "running",
    updatedAt: run.startedAt,
    finishedAt: null,
    exitCode: null,
    ...run
  };
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(record, null, 2)}\n`);
}

// Read the currently running session (null if no session is live).
export function readRunningPhaseRun(dir: string): PhaseRun | null {
  const p = path.join(dir, "running.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as PhaseRun;
}

// Patch the running session in place.
export function updateRunningPhaseRun(dir: string, patch: Partial<PhaseRun>): PhaseRun | null {
  const current = readRunningPhaseRun(dir);
  if (!current) {
    return null;
  }
  const updated: PhaseRun = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

// Write a completed phase run record ({runId}.json). Used by both interactive
// finalizers and non-interactive phase runners.
export function writePhaseRunRecord(dir: string, record: PhaseRunRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${record.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

// Read the latest completed run (excludes running.json).
export function readLatestPhaseRunRecord(dir: string): PhaseRunRecord | null {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const latest = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== "running.json")
    .sort()
    .at(-1);

  if (!latest) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as PhaseRunRecord;
}
