import type { AttachInfo, Runtime, RuntimeCreateConfig, RuntimeHandle } from "../../kernel/runtime/runtime.js";
import type { KernelSessionRef } from "../../infra/session-run.js";
import {
  captureOutputAsync,
  createBareSession,
  isSessionAliveAsync,
  killTmuxSession,
  sendLaunchCommand,
  sendMessageAsync,
  tmuxSessionExists,
} from "../../infra/tmux.js";

export class DevtaskTmuxRuntime implements Runtime {
  readonly name = "tmux";

  async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
    if (tmuxSessionExists(config.sessionId)) {
      killTmuxSession(config.sessionId);
    }
    createBareSession(config.sessionId, config.workspacePath);
    sendLaunchCommand(config.sessionId, config.launchCommand);
    return {
      id: config.sessionId,
      runtimeName: this.name,
      data: { sessionName: config.sessionId, workspacePath: config.workspacePath },
    };
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    killTmuxSession(this.sessionName(handle));
  }

  async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
    await sendMessageAsync(this.sessionName(handle), message);
  }

  async isAlive(handle: RuntimeHandle): Promise<boolean> {
    return isSessionAliveAsync(this.sessionName(handle));
  }

  async captureOutput(handle: RuntimeHandle, lines?: number): Promise<string> {
    return captureOutputAsync(this.sessionName(handle), lines);
  }

  getAttachInfo(handle: RuntimeHandle): AttachInfo {
    const sessionName = this.sessionName(handle);
    return {
      command: `tmux attach -t ${sessionName}`,
      description: `Attach to tmux session "${sessionName}"`,
    };
  }

  private sessionName(handle: RuntimeHandle): string {
    return typeof handle.data["sessionName"] === "string" ? handle.data["sessionName"] : handle.id;
  }
}

export async function launchExecutionTmuxSession(config: {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
}): Promise<KernelSessionRef> {
  const runtime = new DevtaskTmuxRuntime();
  const handle = await runtime.create({
    sessionId: config.sessionId,
    workspacePath: config.workspacePath,
    launchCommand: config.launchCommand,
    environment: {},
  });
  return {
    runtimeSessionId: handle.id,
    runtimeName: handle.runtimeName,
    threadId: null,
    data: { ...handle.data },
  };
}
