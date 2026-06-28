import { readConfig } from "../../infra/config.js";
import type { DevtaskPaths } from "../../infra/paths.js";
import type { KernelSessionRef, SessionPhase } from "../../infra/session-run.js";
import { createDevtaskKernel } from "./kernel.js";
import { startTmuxSession } from "./tmux-control.js";
import {
  configureManagedHooks,
  InteractiveClaudeCodeAgent,
  InteractiveCodexAgent,
  type RuntimeHandle,
  type SessionOwner,
} from "@devtask/agent-kernel";

interface InteractiveLaunchAgent {
  createLaunchCommand(
    prompt: string,
    handleId: string,
    options: { taskDir?: string | null; addDirs?: readonly string[]; managedCompletionCommand?: string | null }
  ): { command: string; metadata: Record<string, unknown> };
  getRestoreCommand?(handle: RuntimeHandle): Promise<string | null>;
}

export interface StartKernelPhaseSessionInput {
  paths: DevtaskPaths;
  phase: SessionPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  workspacePath: string;
  prompt: string;
  tmuxSession: string;
  managedCompletionCommand: string | null;
  addDirs?: readonly string[];
  taskDir?: string | null;
}

export interface ResumeKernelPhaseSessionInput {
  paths: DevtaskPaths;
  phase: SessionPhase;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  workspacePath: string;
  tmuxSession: string;
  kernelSession: KernelSessionRef;
  managedCompletionCommand: string | null;
  prompt?: string | null;
}

export interface KernelPhaseSessionLaunch {
  tmuxSession: string;
  kernelSession: KernelSessionRef;
}

export async function startKernelPhaseSession(input: StartKernelPhaseSessionInput): Promise<KernelPhaseSessionLaunch> {
  const config = readConfig(input.paths);
  const kernel = createDevtaskKernel(input.paths, config);
  try {
    const agent = assertInteractiveAgent(kernel.agent);
    const handleId = input.tmuxSession;
    const launch = agent.createLaunchCommand(input.prompt, handleId, {
      taskDir: input.taskDir ?? null,
      addDirs: input.addDirs,
      managedCompletionCommand: input.managedCompletionCommand,
    });
    const handle = await kernel.coordinator.startSession({
      sessionId: input.tmuxSession,
      workspacePath: input.workspacePath,
      launchCommand: launch.command,
      owner: buildOwner(input.phase, input.workId, input.repoId, input.taskId),
      labels: buildLabels(input.phase, input.workId, input.repoId),
      metadata: {
        phase: input.phase,
        workId: input.workId,
        repoId: input.repoId,
        taskId: input.taskId,
      },
    });
    Object.assign(handle.data, launch.metadata, {
      workspacePath: input.workspacePath,
      startedAtMs: Date.now(),
    });
    return {
      tmuxSession: resolveTmuxSession(kernel, handle),
      kernelSession: kernelSessionFromHandle(handle),
    };
  } finally {
    kernel.close();
  }
}

export async function resumeKernelPhaseSession(input: ResumeKernelPhaseSessionInput): Promise<KernelPhaseSessionLaunch> {
  const config = readConfig(input.paths);
  const kernel = createDevtaskKernel(input.paths, config);
  try {
    configureManagedResume(input.kernelSession, input.managedCompletionCommand);
    const previousHandle = runtimeHandleFromKernelSession(input.kernelSession);
    if (input.prompt?.trim()) {
      previousHandle.data["resumePrompt"] = input.prompt.trim();
    }
    const agent = assertInteractiveAgent(kernel.agent);
    if (typeof agent.getRestoreCommand === "function") {
      const restoreCommand = await agent.getRestoreCommand(previousHandle);
      if (restoreCommand) {
        startTmuxSession(input.tmuxSession, ["bash", "-lc", restoreCommand], input.workspacePath);
        return {
          tmuxSession: input.tmuxSession,
          kernelSession: {
            ...input.kernelSession,
            runtimeSessionId: input.tmuxSession,
            runtimeName: "tmux",
            data: {
              ...input.kernelSession.data,
              sessionName: input.tmuxSession,
              workspacePath: input.workspacePath,
            },
          },
        };
      }
    }
    const restored = await kernel.coordinator.restoreSession({
      sessionId: input.tmuxSession,
      workspacePath: input.workspacePath,
      previousHandle,
      owner: buildOwner(input.phase, input.workId, input.repoId, input.taskId),
      labels: buildLabels(input.phase, input.workId, input.repoId),
      metadata: {
        phase: input.phase,
        workId: input.workId,
        repoId: input.repoId,
        taskId: input.taskId,
      },
    });
    if (!restored) {
      throw new Error(`Kernel could not restore ${input.phase} session for ${input.workId}`);
    }
    return {
      tmuxSession: resolveTmuxSession(kernel, restored),
      kernelSession: kernelSessionFromHandle(restored),
    };
  } finally {
    kernel.close();
  }
}

export function runtimeHandleFromKernelSession(session: KernelSessionRef): RuntimeHandle {
  return {
    id: session.runtimeSessionId,
    runtimeName: session.runtimeName,
    data: { ...session.data },
  };
}

function kernelSessionFromHandle(handle: RuntimeHandle): KernelSessionRef {
  return {
    runtimeSessionId: handle.id,
    runtimeName: handle.runtimeName,
    threadId: typeof handle.data["__kernel"] === "object" && handle.data["__kernel"] !== null && "sessionThreadId" in (handle.data["__kernel"] as Record<string, unknown>)
      ? ((handle.data["__kernel"] as Record<string, unknown>)["sessionThreadId"] as string | undefined) ?? null
      : null,
    data: { ...handle.data },
  };
}

function resolveTmuxSession(kernel: ReturnType<typeof createDevtaskKernel>, handle: RuntimeHandle): string {
  const sessionName = typeof handle.data["sessionName"] === "string" ? handle.data["sessionName"] : handle.id;
  void kernel.runtime.getAttachInfo?.(handle);
  return sessionName;
}

function configureManagedResume(
  session: KernelSessionRef,
  managedCompletionCommand: string | null,
): void {
  const codexHome = typeof session.data["codexHome"] === "string" ? session.data["codexHome"] : null;
  if (codexHome) {
    configureManagedHooks(codexHome, managedCompletionCommand);
  }
}

function buildOwner(phase: SessionPhase, workId: string, repoId: string | null, taskId: string | null): SessionOwner {
  if (taskId) {
    return {
      type: "phase-task",
      id: taskId,
      parent: { type: "work", id: workId },
    };
  }
  return {
    type: repoId ? "phase-repo" : "work",
    id: repoId ? `${workId}:${repoId}:${phase}` : workId,
    parent: repoId ? { type: "work", id: workId } : null,
  };
}

function buildLabels(phase: SessionPhase, workId: string, repoId: string | null): Record<string, string> {
  return {
    phase,
    workId,
    ...(repoId ? { repoId } : {}),
  };
}

function assertInteractiveAgent(agent: unknown): InteractiveLaunchAgent {
  if (
    agent instanceof InteractiveCodexAgent ||
    agent instanceof InteractiveClaudeCodeAgent
  ) {
    return agent;
  }
  throw new Error(
    `Kernel agent does not support createLaunchCommand. ` +
    `Configure a supported interactive agent provider (codex or claude-code).`
  );
}
