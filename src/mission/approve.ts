import { DevtaskError } from "../infra/errors.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { sendWorkPhaseFeedback } from "../services/work-service.js";
import { writeGateState } from "./gates.js";
import type { GateName } from "./gates.js";

export async function approveWorkGate(
  paths: DevtaskPaths,
  workId: string,
  gate: GateName,
  message?: string
): Promise<void> {
  const runsDir = phaseRunDir(paths, workId, "orchestrate", null);
  const run = readRunningPhaseRun(runsDir);
  if (!run || run.status !== "running") {
    throw new DevtaskError(
      `No running orchestrator session found for work item "${workId}". ` +
        `Start one with: devtask work orchestrate ${workId}`
    );
  }

  const approvalMessage = message?.trim() || "Approved. Proceed to next stage.";
  await sendWorkPhaseFeedback(paths, "orchestrate", workId, approvalMessage);

  writeGateState(paths, workId, gate, {
    status: "approved",
    message: approvalMessage
  });
}
