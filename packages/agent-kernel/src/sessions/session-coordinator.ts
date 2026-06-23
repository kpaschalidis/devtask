import crypto from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { Agent, AgentSessionInfo, AgentTurnCancellationResult, RunEvent, RunOptions, SendMessageOptions } from '../agent/agent.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runtime } from '../runtime/runtime.js';
import type { WorkspaceSetup } from '../workspace/workspace-setup.js';
import type { SessionHistoryCaptureService } from '../trace/session-history-capture-service.js';
import type { AgentSessionHistoryEvent } from '../trace/session-history-events.js';
import { categoryForAgentEvent, payloadForAgentEvent } from '../trace/session-history-events.js';
import type { SessionLabels, SessionOwner, SessionThreadStatus } from '../trace/session-history.js';
import type { RuntimeHandle } from './session.js';
import {
  clearInstructionCleanup,
  getSessionThreadId,
  setInstructionCleanup,
  setSessionHistoryVisibility,
  setSessionThreadId,
} from './kernel-handle-state.js';
import { KernelError } from '../shared/errors.js';
import { normalizeArtifactPrefix, type ArtifactNamingConfig } from '../shared/naming.js';
import type { PreparedSessionInstructions, SessionInstructions } from '../instructions/instruction-payload.js';

export interface SessionCoordinatorLogger {
  info?(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
}

export interface SessionCoordinatorConfig extends ArtifactNamingConfig {
  agent: Agent;
  runtime: Runtime;
  workspaceSetup: WorkspaceSetup;
  sessionHistory: SessionHistoryCaptureService;
  logger: SessionCoordinatorLogger;
}

export interface StartSessionInput {
  sessionId?: string;
  workspacePath: string;
  launchCommand?: string;
  instructions?: SessionInstructions;
  owner?: SessionOwner;
  labels?: SessionLabels;
  metadata?: Record<string, unknown>;
}

export interface RestoreSessionInput {
  sessionId?: string;
  workspacePath: string;
  previousHandle: RuntimeHandle;
  instructions?: SessionInstructions;
  owner?: SessionOwner;
  labels?: SessionLabels;
  metadata?: Record<string, unknown>;
}

export class SessionCoordinator {
  private readonly historyVisibilityByRuntime = new Map<string, 'visible' | 'hidden'>();
  private readonly artifactPrefix: string;

  constructor(private readonly config: SessionCoordinatorConfig) {
    this.artifactPrefix = normalizeArtifactPrefix(config.artifactPrefix, 'agent');
  }

  async startSession(input: StartSessionInput): Promise<RuntimeHandle> {
    const { agent, runtime, workspaceSetup } = this.config;
    const sessionId = input.sessionId ?? createSessionId(this.artifactPrefix);
    const setup = await workspaceSetup.prepare({
      workspacePath: input.workspacePath,
      agentName: agent.name,
      owner: input.owner,
      labels: input.labels,
    });
    const instructions = await prepareSessionInstructions(sessionId, this.artifactPrefix, input.instructions);
    const environment = mergeEnvironment(setup.env, setup.pathEntries, agent.getEnvironment(input.workspacePath));
    let sessionThreadId: string | null = null;
    const pendingHistoryEvents: AgentSessionHistoryEvent[] = [];
    const onHistoryEvent = (event: AgentSessionHistoryEvent) => {
      if (!sessionThreadId) {
        pendingHistoryEvents.push(event);
        return;
      }
      this.recordAgentHistoryEvent(sessionThreadId, sessionId, event);
    };

    let handle: RuntimeHandle;
    try {
      handle = agent.createSession
        ? await agent.createSession({
            workspacePath: input.workspacePath,
            sessionId,
            environment,
            instructions,
            onHistoryEvent,
          })
        : await runtime.create({
            sessionId,
            workspacePath: input.workspacePath,
            launchCommand: input.launchCommand ?? await agent.getLaunchCommand(input.workspacePath, instructions),
            environment,
          });
    } catch (error) {
      await instructions.cleanup?.();
      throw error;
    }

    handle.data['agentName'] = agent.name;
    setInstructionCleanup(handle, instructions.cleanup);
    if (input.owner) {
      const thread = this.config.sessionHistory.openThread({
        owner: input.owner,
        labels: input.labels,
        agentName: agent.name,
        runtimeSessionId: handle.id,
        metadata: { workspacePath: input.workspacePath, ...(input.metadata ?? {}) },
      });
      sessionThreadId = thread.id;
      setSessionThreadId(handle, thread.id);
      for (const event of pendingHistoryEvents) {
        this.recordAgentHistoryEvent(thread.id, sessionId, event);
      }
    }
    return handle;
  }

  async sendMessage(handle: RuntimeHandle, taskInput: string, opts?: SendMessageOptions): Promise<void> {
    const { agent, runtime } = this.config;
    const visibility = opts?.history?.visible === false ? 'hidden' : 'visible';
    setSessionHistoryVisibility(handle, visibility);
    this.historyVisibilityByRuntime.set(handle.id, visibility);
    this.recordUserMessage(handle, taskInput, opts);
    if (agent.sendMessage) {
      await agent.sendMessage(handle, runtime, taskInput, opts);
      return;
    }
    if (!taskInput.trim()) {
      throw new KernelError('Runtime-backed agents require taskInput when sendMessage is used');
    }
    await runtime.sendMessage(handle, taskInput);
  }

  readEvents(handle: RuntimeHandle, opts?: RunOptions): AsyncIterable<RunEvent> {
    return this.config.agent.readEvents(handle, this.config.runtime, opts);
  }

  async restoreSession(input: RestoreSessionInput): Promise<RuntimeHandle | null> {
    const { agent, runtime, logger } = this.config;
    const previousHandle = input.previousHandle;

    const releasePreviousHandle = async () => {
      await runInstructionCleanup(previousHandle);
      if (!agent.createSession) {
        try { await runtime.destroy(previousHandle); } catch { /* best effort */ }
      }
      agent.release?.(previousHandle);
    };

    let handle: RuntimeHandle | null = null;

    if (agent.restoreSession) {
      await releasePreviousHandle();
      const setup = await this.config.workspaceSetup.prepare({
        workspacePath: input.workspacePath,
        agentName: agent.name,
        owner: input.owner,
        labels: input.labels,
      });
      const sessionId = input.sessionId ?? createSessionId(this.artifactPrefix);
      const instructions = await prepareSessionInstructions(sessionId, this.artifactPrefix, input.instructions);
      const environment = mergeEnvironment(setup.env, setup.pathEntries, agent.getEnvironment(input.workspacePath));
      let sessionThreadId = getSessionThreadId(previousHandle) ?? null;
      const pendingHistoryEvents: AgentSessionHistoryEvent[] = [];
      let bufferHistoryEvents = true;
      const onHistoryEvent = (event: AgentSessionHistoryEvent) => {
        if (bufferHistoryEvents || !sessionThreadId) {
          pendingHistoryEvents.push(event);
          return;
        }
        this.recordAgentHistoryEvent(sessionThreadId, sessionId, event);
      };
      try {
        handle = await agent.restoreSession({
          workspacePath: input.workspacePath,
          sessionId,
          environment,
          instructions,
          previousHandle,
          onHistoryEvent,
        });
      } catch (error) {
        await instructions.cleanup?.();
        throw error;
      }
      setInstructionCleanup(handle, instructions.cleanup);
      if (sessionThreadId) {
        setSessionThreadId(handle, sessionThreadId);
        this.config.sessionHistory.attachRuntime(sessionThreadId, handle.id, {
          workspacePath: input.workspacePath,
          ...(input.metadata ?? {}),
        });
        for (const event of pendingHistoryEvents) {
          this.recordAgentHistoryEvent(sessionThreadId, sessionId, event);
        }
        bufferHistoryEvents = false;
      }
    } else if (agent.getRestoreCommand) {
      const restoreCommand = await agent.getRestoreCommand(previousHandle);
      if (!restoreCommand) return null;

      await releasePreviousHandle();
      handle = await this.startSession({
        workspacePath: input.workspacePath,
        launchCommand: restoreCommand,
        instructions: input.instructions,
        owner: input.owner,
        labels: input.labels,
        metadata: input.metadata,
      });
    }

    if (!handle) return null;

    handle.data = {
      ...previousHandle.data,
      ...handle.data,
      agentName: agent.name,
    };
    logger.info?.({ sessionId: handle.id }, 'Restored agent session');
    return handle;
  }

  async ensureSessionAlive(handle: RuntimeHandle): Promise<boolean> {
    const { agent, runtime } = this.config;
    return agent.isSessionAlive
      ? agent.isSessionAlive(handle)
      : runtime.isAlive(handle);
  }

  async stopSession(handle: RuntimeHandle, historyStatus: SessionThreadStatus = 'abandoned'): Promise<void> {
    const { agent, runtime, logger } = this.config;
    try {
      if (!agent.createSession) {
        await runtime.destroy(handle);
      }
    } catch (err) {
      logger.warn({ sessionId: handle.id, err }, 'Failed to destroy agent runtime');
    } finally {
      const threadId = getSessionThreadId(handle);
      if (threadId) {
        this.config.sessionHistory.closeThread(threadId, historyStatus);
      }
      await runInstructionCleanup(handle);
      agent.release?.(handle);
    }
  }

  async interruptSession(handle: RuntimeHandle): Promise<AgentTurnCancellationResult> {
    const { agent, runtime, logger } = this.config;

    if (agent.cancelTurn) {
      const result = await agent.cancelTurn(handle, runtime);
      if (result.mode === 'graceful') return result;
      if (result.mode === 'hard') {
        await this.stopSession(handle, 'abandoned');
        return result;
      }
    }

    if (!agent.createSession) {
      try {
        await runtime.destroy(handle);
      } catch (err) {
        logger.warn({ sessionId: handle.id, err }, 'Failed to destroy agent runtime during interruption');
      } finally {
        const threadId = getSessionThreadId(handle);
        if (threadId) this.config.sessionHistory.closeThread(threadId, 'abandoned', { reason: 'interrupted' });
        await runInstructionCleanup(handle);
        agent.release?.(handle);
      }
      return { mode: 'hard', message: 'Runtime-backed session was destroyed because the agent does not support turn cancellation.' };
    }

    return { mode: 'unsupported', message: 'Agent does not support turn cancellation.' };
  }

  async getSessionInfo(handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    return this.config.agent.getSessionInfo?.(handle) ?? null;
  }

  private recordUserMessage(handle: RuntimeHandle, taskInput: string, opts?: SendMessageOptions): void {
    const threadId = getSessionThreadId(handle);
    if (!threadId) return;
    const history = opts?.history ?? {};
    this.config.sessionHistory.append(threadId, {
      source: 'user',
      category: 'message',
      type: 'message.sent',
      runtimeSessionId: handle.id,
      visibility: history.visible === false ? 'hidden' : 'visible',
      payload: {
        role: 'user',
        text: taskInput,
        kind: history.kind ?? 'user-initiated',
      },
    });
  }

  private recordAgentHistoryEvent(threadId: string, runtimeSessionId: string, event: AgentSessionHistoryEvent): void {
    this.config.sessionHistory.append(threadId, {
      source: event.type.startsWith('tool.') ? 'tool' : 'agent',
      category: categoryForAgentEvent(event.type),
      type: event.type,
      turnId: 'turnId' in event ? event.turnId ?? null : null,
      itemId: 'itemId' in event ? event.itemId ?? null : null,
      parentItemId: 'parentItemId' in event ? event.parentItemId ?? null : null,
      runtimeSessionId,
      visibility: 'visibility' in event ? event.visibility ?? this.visibilityForRuntime(runtimeSessionId) : this.visibilityForRuntime(runtimeSessionId),
      payload: payloadForAgentEvent(event),
    });
  }

  private visibilityForRuntime(runtimeSessionId: string): 'visible' | 'hidden' {
    return this.historyVisibilityByRuntime.get(runtimeSessionId) ?? 'visible';
  }
}

export function assertRestorable(handle: RuntimeHandle | undefined | null, kind: string, id: string): RuntimeHandle {
  if (!handle) throw new KernelError(`No active session for ${kind}: ${id}`);
  return handle;
}

function createSessionId(prefix: string): string {
  return `${prefix}-session-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function mergeEnvironment(
  setupEnv: Record<string, string>,
  pathEntries: string[],
  agentEnv: Record<string, string>,
): Record<string, string> {
  const env = { ...setupEnv, ...agentEnv };
  if (pathEntries.length > 0) {
    env['PATH'] = [...pathEntries, env['PATH'] ?? process.env['PATH'] ?? ''].filter(Boolean).join(':');
  }
  return env;
}

async function prepareSessionInstructions(
  sessionId: string,
  artifactPrefix: string,
  instructions?: SessionInstructions,
): Promise<PreparedSessionInstructions & { cleanup?: () => Promise<void> }> {
  const persistentInstructions = instructions?.persistentInstructions?.trim();
  if (!persistentInstructions) return {};

  const baseDir = join(tmpdir(), `${artifactPrefix}-instructions-${sessionId}`);
  await mkdir(baseDir, { recursive: true });
  const persistentInstructionsFile = join(baseDir, 'persistent-instructions.md');
  await writeFile(persistentInstructionsFile, persistentInstructions, 'utf-8');

  return {
    persistentInstructions,
    persistentInstructionsFile,
    cleanup: async () => {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

async function runInstructionCleanup(handle: RuntimeHandle): Promise<void> {
  const cleanup = clearInstructionCleanup(handle);
  if (cleanup) {
    await cleanup();
  }
}
