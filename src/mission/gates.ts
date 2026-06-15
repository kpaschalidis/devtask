import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { workItemGatesDir } from "../infra/paths.js";

export type GateName = "gate-1" | "gate-2";
export type GateStatus = "pending" | "approved" | "rejected";

export interface GateState {
  gate: GateName;
  workId: string;
  status: GateStatus;
  message: string | null;
  updatedAt: string;
}

export function readGateState(paths: DevtaskPaths, workId: string, gate: GateName): GateState | null {
  const filePath = path.join(workItemGatesDir(paths, workId), `${gate}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as GateState;
  } catch {
    return null;
  }
}

export function writeGateState(
  paths: DevtaskPaths,
  workId: string,
  gate: GateName,
  patch: Partial<GateState>
): void {
  const dir = workItemGatesDir(paths, workId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${gate}.json`);
  const existing = readGateState(paths, workId, gate);
  const next: GateState = {
    gate,
    workId,
    status: "pending",
    message: null,
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
}
