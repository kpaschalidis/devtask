import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir, workItemReviewDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists } from "../infra/tmux.js";
import { readGateState } from "../mission/gates.js";
import type { GateState } from "../mission/gates.js";

export interface ValidatorRepoResult {
  repoId: string;
  status: "passed" | "failed" | "unknown";
  totalAssertions: number;
  failedAssertions: number;
}

export interface WorkStatus {
  workId: string;
  orchestratorSession: {
    running: boolean;
    tmuxSession: string | null;
    runId: string | null;
  };
  gate1: GateState | null;
  gate2: GateState | null;
  validatorResults: ValidatorRepoResult[];
  nextAction: string | null;
}

export function getWorkStatus(paths: DevtaskPaths, workId: string): WorkStatus {
  const runsDir = phaseRunDir(paths, workId, "orchestrate", null);
  const run = readRunningPhaseRun(runsDir);

  const orchestratorSession = {
    running: run !== null && run.status === "running" && tmuxSessionExists(run.tmuxSession ?? ""),
    tmuxSession: run?.tmuxSession ?? null,
    runId: run?.runId ?? null
  };

  const gate1 = readGateState(paths, workId, "gate-1");
  const gate2 = readGateState(paths, workId, "gate-2");

  const validatorResults = readValidatorResults(paths, workId);

  return { workId, orchestratorSession, gate1, gate2, validatorResults, nextAction: null };
}

function readValidatorResults(paths: DevtaskPaths, workId: string): ValidatorRepoResult[] {
  const reviewDir = workItemReviewDir(paths, workId);
  if (!fs.existsSync(reviewDir)) return [];

  return fs
    .readdirSync(reviewDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const repoId = f.replace(/\.json$/, "");
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(reviewDir, f), "utf8")) as {
          status?: unknown;
          assertions?: Array<{ status?: unknown }>;
        };
        const status =
          raw.status === "passed" || raw.status === "failed" ? raw.status : "unknown";
        const assertions = Array.isArray(raw.assertions) ? raw.assertions : [];
        const failedAssertions = assertions.filter((a) => a.status === "failed").length;
        return { repoId, status, totalAssertions: assertions.length, failedAssertions };
      } catch {
        return { repoId, status: "unknown" as const, totalAssertions: 0, failedAssertions: 0 };
      }
    });
}
