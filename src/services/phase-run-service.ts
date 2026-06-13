import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { GLOBAL_PHASES, phaseRunDir, workItemLocalDir } from "../infra/paths.js";
import { readRunningPhaseRun, type PhaseRun, type PhaseRunPhase, type PhaseRunRecord } from "../infra/phase-run.js";
import { tmuxSessionExists } from "../infra/tmux.js";

export interface PhaseRunSummary extends PhaseRunRecord {
  filePath: string;
}

export interface PhaseSessionSummary {
  phase: PhaseRunPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  runId: string;
  tmuxSession: string;
  status: string;
  live: boolean;
  startedAt: string;
  updatedAt: string;
  promptPath: string;
  outputPath: string;
  artifacts: Record<string, string>;
  session: PhaseRun["session"];
}

export function listWorkPhaseSessions(paths: DevtaskPaths, workId: string): PhaseSessionSummary[] {
  const base = path.join(paths.localDir, "work", workId, "phases");
  if (!fs.existsSync(base)) {
    return [];
  }

  const entries: PhaseSessionSummary[] = [];
  const managedPhases: PhaseRunPhase[] = ["orchestrate", "repo-plan", "review", "execute"];
  for (const phase of managedPhases) {
    const phaseDir = path.join(base, phase);
    if (!fs.existsSync(phaseDir)) {
      continue;
    }
    if (GLOBAL_PHASES.has(phase)) {
      const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase, null));
      if (run) entries.push(toPhaseSessionSummary(run));
      continue;
    }
    for (const repoDir of fs.readdirSync(phaseDir)) {
      const run = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoDir));
      if (run) entries.push(toPhaseSessionSummary(run));
    }
  }

  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function toPhaseSessionSummary(run: PhaseRun): PhaseSessionSummary {
  return {
    phase: run.phase,
    workId: run.workId,
    repoId: run.repoId,
    taskId: run.taskId,
    runId: run.runId,
    tmuxSession: run.tmuxSession ?? "",
    status: run.status,
    live: run.status === "running" && tmuxSessionExists(run.tmuxSession ?? ""),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    promptPath: run.promptPath,
    outputPath: run.outputPath,
    artifacts: run.artifacts,
    session: run.session
  };
}

export interface ListWorkPhaseRunsOptions {
  phase?: PhaseRunPhase;
  repoId?: string;
  latest?: boolean;
}

const PHASES: PhaseRunPhase[] = ["orchestrate", "repo-plan", "execute", "review", "compound"];

export function listWorkPhaseRuns(
  paths: DevtaskPaths,
  workId: string,
  options: ListWorkPhaseRunsOptions = {}
): PhaseRunSummary[] {
  const phases = options.phase ? [options.phase] : PHASES;
  const runs = phases.flatMap((phase) => listPhaseRuns(paths, workId, phase, options.repoId));
  runs.sort(compareRunsDesc);
  if (!options.latest) {
    return runs;
  }

  const latestRuns = new Map<string, PhaseRunSummary>();
  for (const run of runs) {
    const key = `${run.phase}:${run.repoId ?? "-"}`;
    if (!latestRuns.has(key)) {
      latestRuns.set(key, run);
    }
  }
  return [...latestRuns.values()].sort(compareRunsDesc);
}

export function getLatestWorkPhaseRun(
  paths: DevtaskPaths,
  workId: string,
  phase: PhaseRunPhase,
  repoId?: string
): PhaseRunSummary | null {
  return listWorkPhaseRuns(paths, workId, { phase, repoId }).at(0) ?? null;
}

function listPhaseRuns(
  paths: DevtaskPaths,
  workId: string,
  phase: PhaseRunPhase,
  repoId?: string
): PhaseRunSummary[] {
  const phaseDir = phaseRunDir(paths, workId, phase, null);
  if (!fs.existsSync(phaseDir)) {
    return [];
  }

  if (GLOBAL_PHASES.has(phase)) {
    return readRunFiles(phaseDir);
  }

  const repoDirs = repoId ? [phaseRunDir(paths, workId, phase, repoId)] : listChildDirs(phaseDir);
  return repoDirs.flatMap((dir) => readRunFiles(dir));
}

function listChildDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function readRunFiles(dir: string): PhaseRunSummary[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json") && entry !== "running.json")
    .sort()
    .map((entry) => {
      const filePath = path.join(dir, entry);
      return {
        ...(JSON.parse(fs.readFileSync(filePath, "utf8")) as PhaseRunRecord),
        filePath
      };
    });
}

function compareRunsDesc(left: PhaseRunSummary, right: PhaseRunSummary): number {
  return right.runId.localeCompare(left.runId);
}

export function hasWorkPhaseRuns(paths: DevtaskPaths, workId: string): boolean {
  return fs.existsSync(path.join(workItemLocalDir(paths, workId), "phases"));
}
