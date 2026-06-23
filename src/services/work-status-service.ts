import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir, workItemReviewDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists } from "../adapters/agent-kernel/tmux-control.js";
import { readGateState } from "../mission/gates.js";
import type { GateState } from "../mission/gates.js";

export interface ValidatorAssertion {
  id: string;
  status: "passed" | "failed" | "skipped";
  evidence: string;
  attribution: "spec-gap" | "implementation-gap" | "environment" | "wrong-repo" | "inconclusive" | null;
  attributionReason: string | null;
}

export interface ValidatorRepoResult {
  repoId: string;
  status: "passed" | "failed" | "unknown";
  totalAssertions: number;
  failedAssertions: number;
  assertions: ValidatorAssertion[];
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
          assertions?: Array<{
            id?: unknown;
            status?: unknown;
            evidence?: unknown;
            attribution?: unknown;
            attributionReason?: unknown;
          }>;
        };
        const status =
          raw.status === "passed" || raw.status === "failed" ? raw.status : "unknown";
        const rawAssertions = Array.isArray(raw.assertions) ? raw.assertions : [];
        const assertions: ValidatorAssertion[] = rawAssertions.map((a) => ({
          id: typeof a.id === "string" ? a.id : "?",
          status: a.status === "failed" || a.status === "skipped" ? a.status : "passed",
          evidence: typeof a.evidence === "string" ? a.evidence : "",
          attribution: isValidAttribution(a.attribution) ? a.attribution : null,
          attributionReason: typeof a.attributionReason === "string" ? a.attributionReason : null,
        }));
        const failedAssertions = assertions.filter((a) => a.status === "failed").length;
        return { repoId, status, totalAssertions: assertions.length, failedAssertions, assertions };
      } catch {
        return { repoId, status: "unknown" as const, totalAssertions: 0, failedAssertions: 0, assertions: [] };
      }
    });
}

function isValidAttribution(value: unknown): value is ValidatorAssertion["attribution"] {
  return value === "spec-gap" || value === "implementation-gap" || value === "environment" || value === "wrong-repo" || value === "inconclusive";
}
