import type { DevtaskPaths } from "../infra/paths.js";
import { listWorkPhaseRuns, type PhaseRunSummary } from "./phase-run-service.js";

// Lists phase runs as agent session entries. After Step C, session data lives
// in phases/{phase}/{repoId?}/{runId}.json — no separate sessions/ registry.
export function listWorkAgentSessions(
  paths: DevtaskPaths,
  workId: string,
  options: { latest?: boolean } = {}
): PhaseRunSummary[] {
  return listWorkPhaseRuns(paths, workId, { latest: options.latest });
}
