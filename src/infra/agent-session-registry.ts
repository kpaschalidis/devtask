import fs from "node:fs";
import path from "node:path";
import type { AgentSessionRef } from "../agent-session.js";

export interface AgentSessionRegistryEntry {
  schemaVersion: 1;
  runId: string;
  workId: string;
  phase: string;
  repoId: string | null;
  taskId: string | null;
  status: string;
  startedAt: string;
  finishedAt: string;
  session: AgentSessionRef;
}

export function writeAgentSessionRegistryEntry(dir: string, entry: AgentSessionRegistryEntry): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${entry.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`);
  return filePath;
}

export function readAgentSessionRegistryEntries(dir: string): AgentSessionRegistryEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as AgentSessionRegistryEntry);
}
