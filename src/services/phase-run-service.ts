import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { workItemPhaseRunsDir, workItemLocalDir } from "../infra/paths.js";
import type { PhaseRunPhase, PhaseRunRecord } from "../infra/phase-run.js";

export interface PhaseRunSummary extends PhaseRunRecord {
  filePath: string;
}

export interface ListWorkPhaseRunsOptions {
  phase?: PhaseRunPhase;
  repoId?: string;
  latest?: boolean;
}

const PHASES: PhaseRunPhase[] = ["spec", "plan", "repo-plan", "execute", "review", "compound"];

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
  const phaseDir = workItemPhaseRunsDir(paths, workId, phase);
  if (!fs.existsSync(phaseDir)) {
    return [];
  }

  if (phase === "spec" || phase === "plan" || phase === "compound") {
    return readRunFiles(phaseDir);
  }

  const repoDirs = repoId ? [path.join(phaseDir, repoId)] : listChildDirs(phaseDir);
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
