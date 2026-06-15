import fs from "node:fs";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists } from "../infra/tmux.js";
import { readGateState } from "./gates.js";
import { approveWorkGate } from "./approve.js";
import type { GateName } from "./gates.js";

const GATE_MARKERS: Array<{ gate: GateName; marker: string }> = [
  { gate: "gate-1", marker: "Gate 1: Awaiting approval" },
  { gate: "gate-2", marker: "Gate 2: Awaiting approval" }
];

const POLL_INTERVAL_MS = 5000;

export interface AutoApproveOptions {
  message?: string;
  initialOutputOffset?: number;
  onApprove?: (gate: GateName) => void;
  onComplete?: () => void;
}

export async function watchAndAutoApprove(
  paths: DevtaskPaths,
  workId: string,
  options: AutoApproveOptions = {}
): Promise<void> {
  const runsDir = phaseRunDir(paths, workId, "orchestrate", null);

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const run = readRunningPhaseRun(runsDir);

      if (!run || run.status !== "running" || !tmuxSessionExists(run.tmuxSession ?? "")) {
        clearInterval(interval);
        options.onComplete?.();
        resolve();
        return;
      }

      let output = "";
      try {
        const buf = fs.readFileSync(run.outputPath);
        output = buf.subarray(options.initialOutputOffset ?? 0).toString("utf8");
      } catch {
        return;
      }

      for (const { gate, marker } of GATE_MARKERS) {
        if (!output.includes(marker)) continue;
        const existing = readGateState(paths, workId, gate);
        if (existing?.status === "approved") continue;

        try {
          await approveWorkGate(paths, workId, gate, options.message);
          options.onApprove?.(gate);
        } catch {
          // Session may have already exited or marker was a false positive — skip.
        }
      }
    }, POLL_INTERVAL_MS);
  });
}
