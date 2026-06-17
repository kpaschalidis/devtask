import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir, workItemAutoApprovePidPath } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { tmuxSessionExists } from "../infra/tmux.js";
import { readGateState } from "./gates.js";
import { approveWorkGate } from "./approve.js";
import type { GateName } from "./gates.js";
import { readWorkGraph } from "../work-materializer.js";

const GATE_MARKERS: Array<{ gate: GateName; marker: string }> = [
  { gate: "gate-1", marker: "Gate 1: Awaiting approval" },
  { gate: "gate-2", marker: "Gate 2: Awaiting approval" }
];

const POLL_INTERVAL_MS = 5000;

export interface AutoApproveOptions {
  message?: string;
  initialOutputOffset?: number;
  acceptRecommended?: boolean;
  onApprove?: (gate: GateName) => void;
  onComplete?: () => void;
  onPendingQuestions?: (gate: GateName, questions: string[]) => void;
}

export async function watchAndAutoApprove(
  paths: DevtaskPaths,
  workId: string,
  options: AutoApproveOptions = {}
): Promise<void> {
  const runsDir = phaseRunDir(paths, workId, "orchestrate", null);

  return new Promise((resolve) => {
    const lastNotifiedQuestions = new Map<GateName, string>();
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

        if (gate === "gate-1" && !options.acceptRecommended) {
          const openQuestions = readGraphOpenQuestions(paths, workId);
          if (openQuestions === null) {
            // partial write in progress — block silently, retry next tick
            continue;
          }
          if (openQuestions.length > 0) {
            const key = JSON.stringify(openQuestions);
            if (lastNotifiedQuestions.get(gate) !== key) {
              lastNotifiedQuestions.set(gate, key);
              options.onPendingQuestions?.(gate, openQuestions);
            }
            continue;
          }
        }

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

export function isAutoApproveWatcherAlive(paths: DevtaskPaths, workId: string): boolean {
  const pid = readAutoApprovePid(paths, workId);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeAutoApprovePid(paths: DevtaskPaths, workId: string): void {
  const pidPath = workItemAutoApprovePidPath(paths, workId);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
}

export function clearAutoApprovePid(paths: DevtaskPaths, workId: string): void {
  try {
    fs.unlinkSync(workItemAutoApprovePidPath(paths, workId));
  } catch {
    // ignore if already gone
  }
}

function readAutoApprovePid(paths: DevtaskPaths, workId: string): number | null {
  try {
    const text = fs.readFileSync(workItemAutoApprovePidPath(paths, workId), "utf8").trim();
    const pid = parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Returns [] if graph not yet written, null if file exists but unreadable (partial write — block silently).
function readGraphOpenQuestions(paths: DevtaskPaths, workId: string): string[] | null {
  try {
    return readWorkGraph(paths, workId).openQuestions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
}
