import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";
import type { PhaseRunPhase } from "./phase-run.js";

export interface PhaseSessionRecord {
  schemaVersion: 1;
  phase: Exclude<PhaseRunPhase, "compound">;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  runId: string;
  tmuxSession: string;
  status: "running" | "completed" | "failed" | "blocked";
  startedAt: string;
  updatedAt: string;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: AgentSessionRef;
}

export function writePhaseSessionRecord(dir: string, record: PhaseSessionRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "session.json");
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

export function readPhaseSessionRecord(dir: string): PhaseSessionRecord | null {
  const filePath = path.join(dir, "session.json");
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PhaseSessionRecord;
}

export function deletePhaseSessionRecord(dir: string): void {
  const filePath = path.join(dir, "session.json");
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.unlinkSync(filePath);
}
