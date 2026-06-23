import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../infra/session-ref.js";

export type SessionPhase = "orchestrate" | "repo-plan" | "review" | "execute" | "ci-fix" | "compound";

export interface KernelSessionRef {
  runtimeSessionId: string;
  runtimeName: string;
  threadId: string | null;
  data: Record<string, unknown>;
}

// Unified session run — covers both live sessions and completed records.
// Live sessions are stored as running.json; completed ones as {runId}.json.
export interface SessionRun {
  schemaVersion: 1;
  runId: string;
  phase: SessionPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: string;
  tmuxSession: string | null;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: AgentSessionRef;
  kernelSession?: KernelSessionRef | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

// Backward-compat alias used by non-interactive phase run writers.
export interface SessionRunRecord {
  schemaVersion: 1;
  phase: SessionPhase;
  runId: string;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: string;
  promptPath: string;
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  session: AgentSessionRef;
  kernelSession?: KernelSessionRef | null;
  artifacts: Record<string, string>;
  exitCode: number | null;
}

type SessionRefSource = {
  tmuxSession?: string | null;
  session?: AgentSessionRef | null;
  kernelSession?: KernelSessionRef | null;
};

type SessionRunWriteInput = Omit<SessionRun, "schemaVersion" | "status" | "updatedAt" | "finishedAt" | "exitCode" | "session"> & {
  tmuxSession: string;
  session?: AgentSessionRef | null;
};

export type SessionRunRecordWriteInput = Omit<SessionRunRecord, "schemaVersion" | "session"> & {
  schemaVersion?: 1;
  session?: AgentSessionRef | null;
};

// Write the running session marker (replaces session.json pattern).
export function writeRunningPhaseRun(
  dir: string,
  run: SessionRunWriteInput
): void {
  fs.mkdirSync(dir, { recursive: true });
  const record: SessionRun = {
    schemaVersion: 1,
    status: "running",
    updatedAt: run.startedAt,
    finishedAt: null,
    exitCode: null,
    ...run,
    session: resolveSessionRef(run)
  };
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(record, null, 2)}\n`);
}

// Read the currently running session (null if no session is live).
export function readRunningPhaseRun(dir: string): SessionRun | null {
  const p = path.join(dir, "running.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  return normalizeSessionRun(JSON.parse(fs.readFileSync(p, "utf8")) as SessionRun);
}

// Patch the running session in place.
export function updateRunningPhaseRun(dir: string, patch: Partial<SessionRun>): SessionRun | null {
  const current = readRunningPhaseRun(dir);
  if (!current) {
    return null;
  }
  const updated: SessionRun = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, "running.json"), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

// Write a completed session run record ({runId}.json). Used by both interactive
// finalizers and non-interactive phase runners.
export function writePhaseRunRecord(dir: string, record: SessionRunRecordWriteInput): string {
  fs.mkdirSync(dir, { recursive: true });
  const normalized: SessionRunRecord = {
    schemaVersion: 1,
    ...record,
    session: resolveSessionRef(record)
  };
  const filePath = path.join(dir, `${record.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return filePath;
}

// Read the latest completed run (excludes running.json).
export function readLatestPhaseRunRecord(dir: string): SessionRunRecord | null {
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

  return normalizeSessionRunRecord(JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as SessionRunRecord);
}

function normalizeSessionRun(run: SessionRun): SessionRun {
  return {
    ...run,
    session: resolveSessionRef(run),
    kernelSession: run.kernelSession ?? null
  };
}

function normalizeSessionRunRecord(run: SessionRunRecord): SessionRunRecord {
  return {
    ...run,
    session: resolveSessionRef(run),
    kernelSession: run.kernelSession ?? null
  };
}

export function resolveSessionRef(source: SessionRefSource): AgentSessionRef {
  if (source.session) {
    return source.session;
  }

  const kernelSession = source.kernelSession;
  const data = kernelSession?.data ?? {};
  const threadId = typeof data["threadId"] === "string" ? data["threadId"] : kernelSession?.threadId ?? null;
  const codexHome = typeof data["codexHome"] === "string" ? data["codexHome"] : null;
  const transcriptPath = typeof data["transcriptPath"] === "string" ? data["transcriptPath"] : null;
  const agentName = typeof data["agentName"] === "string" ? data["agentName"] : null;
  const provider = agentName === "cursor" ? "cursor" : agentName === "claude-code" ? "claude-code" : "codex";

  return {
    provider,
    transportId: source.tmuxSession ?? kernelSession?.runtimeSessionId ?? null,
    resumeContext: {
      providerSessionId: threadId,
      conversationId: threadId,
      resumeTarget: threadId,
      storageRoot: codexHome,
      transcriptPath,
    },
    summary: null,
    summaryIsFallback: null,
  };
}
