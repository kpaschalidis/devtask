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

  // For interactive agents (e.g. codex), send the approval to the live session.
  // For non-interactive agents (e.g. claude-code --print), the session exits after
  // producing artifacts, so we just write the gate state directly.
  if (!run) {
    // Check that the orchestrate phase ran at all before allowing approval
    const { listWorkPhaseRuns } = await import("../services/session-run-service.js");
    const runs = listWorkPhaseRuns(paths, workId, { latest: false });
    const hasOrchestrate = runs.some((r) => r.phase === "orchestrate");
    if (!hasOrchestrate) {
      throw new DevtaskError(
        `No orchestrator session found for work item "${workId}". ` +
          `Start one with: devtask work orchestrate ${workId}`
      );
    }
  }

  const approvalMessage = message?.trim() || "Approved. Proceed to next stage.";

  if (run?.status === "running" && run.tmuxSession && tmuxSessionExists(run.tmuxSession)) {
    // Interactive agent: send approval to the live session.
    sendToTmuxSession(run.tmuxSession, approvalMessage);
  } else if (run?.status === "running" && run.session?.provider !== "claude-code") {
    // Interactive agent that exited: resume it with the approval message.
    await sendWorkPhaseFeedback(paths, "orchestrate", workId, approvalMessage);
  }
  // For completed/failed runs or non-interactive agents: just write the gate state below.

  writeGateState(paths, workId, gate, {
    status: "approved",
    message: approvalMessage
  });
}
