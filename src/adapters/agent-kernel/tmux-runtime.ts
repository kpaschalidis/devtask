import { TmuxRuntime } from "@devtask/agent-kernel";
import type { KernelSessionRef } from "../../infra/session-run.js";

export async function launchExecutionTmuxSession(config: {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
}): Promise<KernelSessionRef> {
  const runtime = new TmuxRuntime({ artifactPrefix: "devtask" });
  const handle = await runtime.create({
    sessionId: config.sessionId,
    workspacePath: config.workspacePath,
    launchCommand: config.launchCommand,
    environment: {},
  });
  return { runtimeSessionId: handle.id, runtimeName: handle.runtimeName, threadId: null, data: { ...handle.data } };
}
