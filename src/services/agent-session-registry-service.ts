import type { DevtaskPaths } from "../infra/paths.js";
import { workItemSessionRegistryDir } from "../infra/paths.js";
import { readAgentSessionRegistryEntries, type AgentSessionRegistryEntry } from "../infra/agent-session-registry.js";

export interface AgentSessionRegistrySummary extends AgentSessionRegistryEntry {
  filePath: string;
}

export function listWorkAgentSessions(
  paths: DevtaskPaths,
  workId: string,
  options: { latest?: boolean } = {}
): AgentSessionRegistryEntry[] {
  const dir = workItemSessionRegistryDir(paths, workId);
  const entries = readAgentSessionRegistryEntries(dir).sort((left, right) => right.runId.localeCompare(left.runId));
  if (!options.latest) {
    return entries;
  }

  const latest = new Map<string, AgentSessionRegistryEntry>();
  for (const entry of entries) {
    const key = `${entry.phase}:${entry.repoId ?? "-"}:${entry.taskId ?? "-"}`;
    if (!latest.has(key)) {
      latest.set(key, entry);
    }
  }
  return [...latest.values()].sort((left, right) => right.runId.localeCompare(left.runId));
}
