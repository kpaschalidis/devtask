import { DevtaskError } from "../infra/errors.js";
import { phaseRunDir } from "../infra/paths.js";
import { readRunningPhaseRun } from "../infra/session-run.js";
import { sendToTmuxSession, tmuxSessionExists } from "../infra/tmux.js";
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
  if (!run) {
    throw new DevtaskError(
      `No orchestrator session found for work item "${workId}". ` +
        `Start one with: devtask work orchestrate ${workId}`
    );
  }

  const approvalMessage = message?.trim() || "Approved. Proceed to next stage.";

  if (run.tmuxSession && tmuxSessionExists(run.tmuxSession)) {
    sendToTmuxSession(run.tmuxSession, approvalMessage);
  } else {
    await sendWorkPhaseFeedback(paths, "orchestrate", workId, approvalMessage);
  }

  writeGateState(paths, workId, gate, {
    status: "approved",
    message: approvalMessage
  });
}
