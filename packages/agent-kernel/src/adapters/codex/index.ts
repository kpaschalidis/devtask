import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Agent, AgentCreateSessionInput, AgentRestoreSessionInput, AgentTurnCancellationResult, RunEvent, RunOptions, ActivityState, AgentSessionInfo, SendMessageOptions } from '../../agent/agent.js';
import type { AgentCostEstimate } from '../../agent/agent.js';
import type { PreparedSessionInstructions } from '../../instructions/instruction-payload.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { RuntimeHandle } from '../../runtime/runtime.js';
import type { AgentSessionHistoryEvent } from '../../trace/session-history-events.js';
import { shellEscape } from './shell-escape.js';
import { CodexAppServerClient } from './app-server-client.js';
import type { ThreadStartParams } from './app-server-client.js';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_STALL_MS = 120_000;
const DEFAULT_MAX_TURN_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;

// Notification methods handled explicitly — anything else is logged for discovery.
const KNOWN_NOTIFICATIONS = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/reasoning/textDelta',
  'item/fileChange/outputDelta',
  'turn/completed',
  'error',
  'thread/closed',
  'thread/tokenUsage/updated',
]);

// ─── Per-session state ────────────────────────────────────────────────────────

interface AppServerState {
  client: CodexAppServerClient;
  threadId: string;
  eventQueue: RunEvent[];
  isDone: boolean;
  notify: (() => void) | null;
  lastActivityAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  model: string | null;
  onHistoryEvent?: (event: AgentSessionHistoryEvent) => void;
  currentTurnId: string | null;
}

// ─── Codex binary resolution ──────────────────────────────────────────────────

export async function resolveCodexBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch { /* not found via which */ }

  const home = homedir();
  for (const candidate of [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    join(home, '.cargo', 'bin', 'codex'),
    join(home, '.npm', 'bin', 'codex'),
  ]) {
    try {
      await stat(candidate);
      return candidate;
    } catch { /* not at this location */ }
  }

  return 'codex';
}

// ─── CodexAgent ───────────────────────────────────────────────────────────────

export interface CodexAgentConfig {
  model?: string;
  permissions?: string;
  estimateCostUsd?: (input: {
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  }) => number | null;
  logger?: {
    info?(meta: Record<string, unknown>, message: string): void;
    warn?(meta: Record<string, unknown>, message: string): void;
    error?(meta: Record<string, unknown>, message: string): void;
    debug?(meta: Record<string, unknown>, message: string): void;
  };
}

export class CodexAgent implements Agent {
  readonly name = 'codex';
  readonly promptDelivery = 'post-launch' as const;

  private resolvedBinary: string | null = null;
  private resolvingBinary: Promise<string> | null = null;
  private readonly sessionStates = new Map<string, AppServerState>();

  constructor(private readonly config: CodexAgentConfig = {}) {}

  async getLaunchCommand(_workspacePath: string, _instructions?: PreparedSessionInstructions): Promise<string> {
    return 'sleep 86400';
  }

  getEnvironment(_workspacePath: string): Record<string, string> {
    return { CODEX_DISABLE_UPDATE_CHECK: '1' };
  }

  async createSession(input: AgentCreateSessionInput): Promise<RuntimeHandle> {
    const binary = await this.getResolvedBinary();
    const logger = this.config.logger;
    logger?.info?.({ sessionId: input.sessionId, binary, cwd: input.workspacePath }, '[codex] createSession: resolved binary');

    const client = new CodexAppServerClient({
      binaryPath: binary,
      cwd: input.workspacePath,
      env: input.environment,
      onApproval: async () => 'accept' as const,
      onStderr: logger?.info ? (line) => logger.info?.({ sessionId: input.sessionId }, `[codex] ${line}`) : undefined,
    });

    const handle: RuntimeHandle = {
      id: input.sessionId,
      runtimeName: 'codex-app-server',
      data: { workspacePath: input.workspacePath },
    };

    const state: AppServerState = {
      client,
      threadId: '',
      eventQueue: [],
      isDone: false,
      notify: null,
      lastActivityAt: Date.now(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalReasoningTokens: 0,
      model: null,
      onHistoryEvent: input.onHistoryEvent,
      currentTurnId: null,
    };
    this.sessionStates.set(handle.id, state);

    client.on('notification', (method: string, params: Record<string, unknown>) => {
      this.handleNotification(handle.id, method, params);
    });

    client.on('error', (err: Error) => {
      this.handleClientError(handle.id, err);
    });

    logger?.info?.({ sessionId: input.sessionId }, '[codex] createSession: connecting to app-server');
    try {
      await client.connect();
    } catch (err) {
      this.sessionStates.delete(handle.id);
      await client.close().catch(() => { /* best-effort */ });
      throw err;
    }
    logger?.info?.({ sessionId: input.sessionId }, '[codex] createSession: connected, starting thread');

    const threadResult = await client.threadStart(this.buildThreadParams(input.workspacePath, input.instructions));
    logger?.info?.({ sessionId: input.sessionId, threadResult }, '[codex] createSession: thread started');
    const thread = threadResult['thread'] as Record<string, unknown> | undefined;
    const threadId = (thread?.['id'] ?? threadResult['id']) as string | undefined;
    if (!threadId) throw new Error('Codex app-server did not return a thread ID');

    state.threadId = threadId;
    handle.data['threadId'] = threadId;

    const modelName = threadResult['model'];
    if (typeof modelName === 'string' && modelName) {
      state.model = modelName;
      handle.data['codexModel'] = modelName;
    }

    return handle;
  }

  async restoreSession(input: AgentRestoreSessionInput): Promise<RuntimeHandle> {
    const binary = await this.getResolvedBinary();
    const logger = this.config.logger;
    logger?.info?.({ sessionId: input.sessionId, binary, cwd: input.workspacePath }, '[codex] restoreSession: resolved binary');

    const previousThreadId = input.previousHandle.data['threadId'];
    if (typeof previousThreadId !== 'string' || !previousThreadId) {
      throw new Error('Cannot restore codex session without threadId');
    }

    const client = new CodexAppServerClient({
      binaryPath: binary,
      cwd: input.workspacePath,
      env: input.environment,
      onApproval: async () => 'accept' as const,
      onStderr: logger?.info ? (line) => logger.info?.({ sessionId: input.sessionId }, `[codex] ${line}`) : undefined,
    });

    const handle: RuntimeHandle = {
      id: input.sessionId,
      runtimeName: 'codex-app-server',
      data: { workspacePath: input.workspacePath },
    };

    const state: AppServerState = {
      client,
      threadId: previousThreadId,
      eventQueue: [],
      isDone: false,
      notify: null,
      lastActivityAt: Date.now(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalReasoningTokens: 0,
      model: null,
      onHistoryEvent: input.onHistoryEvent,
      currentTurnId: null,
    };
    this.sessionStates.set(handle.id, state);

    client.on('notification', (method: string, params: Record<string, unknown>) => {
      this.handleNotification(handle.id, method, params);
    });

    client.on('error', (err: Error) => {
      this.handleClientError(handle.id, err);
    });

    logger?.info?.({ sessionId: input.sessionId, threadId: previousThreadId }, '[codex] restoreSession: connecting to app-server');
    try {
      await client.connect();
      await client.threadResume({
        threadId: previousThreadId,
        ...(input.instructions?.persistentInstructions ? { developerInstructions: input.instructions.persistentInstructions } : {}),
      });
    } catch (err) {
      this.sessionStates.delete(handle.id);
      await client.close().catch(() => { /* best-effort */ });
      throw err;
    }

    handle.data['threadId'] = previousThreadId;
    const model = input.previousHandle.data['codexModel'];
    if (typeof model === 'string' && model) {
      state.model = model;
      handle.data['codexModel'] = model;
    }

    return handle;
  }

  async isSessionAlive(handle: RuntimeHandle): Promise<boolean> {
    return this.sessionStates.get(handle.id)?.client.isConnected ?? false;
  }

  async sendMessage(handle: RuntimeHandle, _runtime: Runtime, taskInput: string, opts: SendMessageOptions = {}): Promise<void> {
    const state = this.sessionStates.get(handle.id);
    if (!state) throw new Error(`No active codex app-server session for handle: ${handle.id}`);
    if (!taskInput.trim()) throw new Error('Codex sendMessage requires task input');

    state.isDone = false;
    state.lastActivityAt = Date.now();

    const turnResult = await state.client.turnStart({
      threadId: state.threadId,
      input: taskInput,
      cwd: handle.data['workspacePath'] as string,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    });

    const turn = turnResult['turn'] as Record<string, unknown> | undefined;
    const turnId = turn?.['id'];
    if (typeof turnId === 'string' && turnId) {
      handle.data['codexTurnId'] = turnId;
      state.currentTurnId = turnId;
      state.onHistoryEvent?.({ type: 'turn.started', turnId });
    }
  }

  async cancelTurn(handle: RuntimeHandle, _runtime: Runtime): Promise<AgentTurnCancellationResult> {
    const state = this.sessionStates.get(handle.id);
    if (!state) return { mode: 'unsupported', message: `No active codex app-server session for handle: ${handle.id}` };

    const turnId = typeof handle.data['codexTurnId'] === 'string'
      ? handle.data['codexTurnId']
      : state.currentTurnId;
    if (!turnId) return { mode: 'unsupported', message: 'Codex session has no active turn to interrupt.' };

    await state.client.turnInterrupt(state.threadId, turnId);
    state.isDone = true;
    state.eventQueue = [];
    state.notify?.();
    state.notify = null;
    state.onHistoryEvent?.({ type: 'turn.failed', turnId, error: 'Turn interrupted by user.' });
    return { mode: 'graceful', message: 'Codex turn interrupted.' };
  }

  async *readEvents(
    handle: RuntimeHandle,
    _runtime: Runtime,
    opts?: RunOptions,
  ): AsyncIterable<RunEvent> {
    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS;
    const maxTurnMs = opts?.maxTurnMs ?? DEFAULT_MAX_TURN_MS;

    const state = this.sessionStates.get(handle.id);
    if (!state) {
      yield { kind: 'failed', error: 'No active codex app-server session for this handle' };
      return;
    }

    const startedAt = Date.now();
    state.lastActivityAt = Date.now();

    while (true) {
      while (state.eventQueue.length > 0) {
        const event = state.eventQueue.shift()!;
        state.lastActivityAt = Date.now();
        yield event;
      }

      if (state.isDone) return;

      const now = Date.now();

      if (now - startedAt > maxTurnMs) {
        yield { kind: 'max_turn_exceeded' };
        return;
      }

      if (now - state.lastActivityAt > stallMs) {
        yield { kind: 'stalled' };
        return;
      }

      const remainingStall = stallMs - (now - state.lastActivityAt);
      const remainingMax = maxTurnMs - (now - startedAt);
      const waitMs = Math.min(remainingStall, remainingMax, POLL_INTERVAL_MS);

      await Promise.race([
        new Promise<void>(resolve => { state.notify = resolve; }),
        sleep(waitMs),
      ]);
      state.notify = null;
    }
  }

  async getActivityState(handle: RuntimeHandle, _runtime: Runtime): Promise<ActivityState> {
    const state = this.sessionStates.get(handle.id);
    if (!state || !state.client.isConnected) return 'unknown';
    if (state.isDone) return 'idle';
    return 'active';
  }

  async getSessionInfo(handle: RuntimeHandle): Promise<AgentSessionInfo | null> {
    const threadId = handle.data['threadId'];
    if (typeof threadId !== 'string' || !threadId) return null;

    const state = this.sessionStates.get(handle.id);
    const model = state?.model ?? (handle.data['codexModel'] as string | undefined);

    const inputTokens = state?.totalInputTokens ?? 0;
    const cachedTokens = state?.totalCachedTokens ?? 0;
    const outputTokens = state?.totalOutputTokens ?? 0;
    const reasoningTokens = state?.totalReasoningTokens ?? 0;

    const cost = buildAgentCostEstimate({
      model: model ?? null,
      inputTokens,
      cachedInputTokens: cachedTokens,
      outputTokens,
      reasoningOutputTokens: reasoningTokens,
    }, this.config.estimateCostUsd);

    return {
      summary: model ? `Codex session (${model})` : 'Codex app-server session',
      summaryIsFallback: true,
      agentSessionId: threadId,
      metadata: {
        codexThreadId: threadId,
        ...(model ? { codexModel: model } : {}),
      },
      cost,
    };
  }

  async getRestoreCommand(handle: RuntimeHandle): Promise<string | null> {
    const threadId = handle.data['threadId'];
    if (typeof threadId !== 'string' || !threadId) return null;

    const model = this.config.model
      ?? (typeof handle.data['codexModel'] === 'string' ? handle.data['codexModel'] : undefined);

    const binary = await this.getResolvedBinary();
    const parts = [shellEscape(binary), 'resume'];
    appendNoUpdateCheckFlag(parts);
    appendApprovalFlags(parts, this.config.permissions);
    appendModelFlags(parts, model);
    parts.push(shellEscape(threadId));
    return parts.join(' ');
  }

  release(handle: RuntimeHandle): void {
    const state = this.sessionStates.get(handle.id);
    if (state) {
      state.isDone = true;
      state.notify?.();
      state.client.close().catch(() => { /* best-effort */ });
      this.sessionStates.delete(handle.id);
    }
  }

  private handleNotification(handleId: string, method: string, params: Record<string, unknown>): void {
    const state = this.sessionStates.get(handleId);
    if (!state) return;
    state.lastActivityAt = Date.now();

    // Log any notification we don't explicitly handle — useful for discovering
    // new event types from the Codex protocol as it evolves.
    if (!KNOWN_NOTIFICATIONS.has(method)) {
      this.config.logger?.debug?.({ handleId, method, params }, '[codex] unhandled notification');
      return;
    }

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = params['delta'];
        if (typeof delta === 'string' && delta) {
          state.eventQueue.push({ kind: 'output', text: delta });
          state.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', turnId: currentTurnIdFromState(state), text: delta });
          state.notify?.();
          state.notify = null;
        }
        break;
      }

      case 'turn/completed': {
        const turn = params['turn'] as Record<string, unknown> | undefined;
        const error = turn?.['error'] as Record<string, unknown> | null | undefined;
        if (error) {
          const msg = typeof error['message'] === 'string' ? error['message'] : 'Codex turn failed';
          state.eventQueue.push({ kind: 'failed', error: msg });
          state.onHistoryEvent?.({ type: 'turn.failed', turnId: currentTurnIdFromParams(params), error: msg });
        } else {
          state.eventQueue.push({ kind: 'completed' });
          state.onHistoryEvent?.({ type: 'message.completed', role: 'assistant', turnId: currentTurnIdFromParams(params) });
          state.onHistoryEvent?.({ type: 'turn.completed', turnId: currentTurnIdFromParams(params) });
        }
        state.isDone = true;
        state.notify?.();
        state.notify = null;
        break;
      }

      case 'error': {
        if (!params['willRetry']) {
          const error = params['error'] as Record<string, unknown> | undefined;
          const msg = typeof error?.['message'] === 'string' ? error['message'] : 'Codex error';
          state.eventQueue.push({ kind: 'failed', error: msg });
          state.onHistoryEvent?.({ type: 'turn.failed', turnId: currentTurnIdFromState(state), error: msg });
          state.isDone = true;
          state.notify?.();
          state.notify = null;
        }
        break;
      }

      case 'thread/closed': {
        if (!state.isDone) {
          state.eventQueue.push({ kind: 'failed', error: 'Codex thread closed unexpectedly' });
          state.onHistoryEvent?.({ type: 'turn.failed', turnId: currentTurnIdFromState(state), error: 'Codex thread closed unexpectedly' });
          state.isDone = true;
          state.notify?.();
          state.notify = null;
        }
        break;
      }

      case 'item/commandExecution/outputDelta': {
        const delta = params['delta'] ?? params['output'];
        if (typeof delta === 'string' && delta) {
          state.onHistoryEvent?.({ type: 'tool.output.delta', turnId: currentTurnIdFromState(state), text: delta });
        }
        break;
      }

      case 'item/reasoning/textDelta': {
        const delta = params['delta'];
        if (typeof delta === 'string' && delta) {
          state.onHistoryEvent?.({ type: 'reasoning.delta', turnId: currentTurnIdFromState(state), text: delta });
        }
        break;
      }

      case 'item/fileChange/outputDelta': {
        const delta = params['delta'];
        if (typeof delta === 'string' && delta) {
          state.onHistoryEvent?.({ type: 'file.changed', turnId: currentTurnIdFromState(state), text: delta });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const tokenUsage = params['tokenUsage'] as Record<string, unknown> | undefined;
        const total = tokenUsage?.['total'] as Record<string, unknown> | undefined;
        if (total) {
          state.totalInputTokens = typeof total['inputTokens'] === 'number' ? total['inputTokens'] : 0;
          state.totalOutputTokens = typeof total['outputTokens'] === 'number' ? total['outputTokens'] : 0;
          state.totalCachedTokens = typeof total['cachedInputTokens'] === 'number' ? total['cachedInputTokens'] : 0;
          state.totalReasoningTokens = typeof total['reasoningOutputTokens'] === 'number' ? total['reasoningOutputTokens'] : 0;
          state.onHistoryEvent?.({ type: 'usage.updated', usage: total });
        }
        break;
      }
    }
  }

  private handleClientError(handleId: string, err: Error): void {
    const state = this.sessionStates.get(handleId);
    if (!state || state.isDone) return;
    state.eventQueue.push({ kind: 'failed', error: err.message });
    state.isDone = true;
    state.notify?.();
    state.notify = null;
  }

  private buildThreadParams(workspacePath: string, instructions?: PreparedSessionInstructions): ThreadStartParams {
    const mode = normalizePermissionMode(this.config.permissions);
    const approvalPolicy: ThreadStartParams['approvalPolicy'] =
      mode === 'permissionless' || mode === 'auto-edit' ? 'never' : 'untrusted';

    return {
      cwd: workspacePath,
      ...(this.config.model ? { model: this.config.model } : {}),
      approvalPolicy,
      ...(instructions?.persistentInstructions ? { developerInstructions: instructions.persistentInstructions } : {}),
    };
  }

  private async getResolvedBinary(): Promise<string> {
    if (this.resolvedBinary) return this.resolvedBinary;
    if (!this.resolvingBinary) this.resolvingBinary = resolveCodexBinary();
    try {
      this.resolvedBinary = await this.resolvingBinary;
    } finally {
      this.resolvingBinary = null;
    }
    return this.resolvedBinary;
  }
}

export interface CodexTokenUsage {
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export function buildAgentCostEstimate(
  usage: CodexTokenUsage,
  estimateCostUsd?: CodexAgentConfig['estimateCostUsd'],
): AgentCostEstimate | undefined {
  const totalInput = usage.inputTokens + usage.cachedInputTokens;
  if (totalInput === 0 && usage.outputTokens === 0) return undefined;
  const estimatedCostUsd = usage.model && estimateCostUsd
    ? estimateCostUsd({
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
      })
    : null;
  return {
    inputTokens: totalInput,
    outputTokens: usage.outputTokens,
    ...(estimatedCostUsd === null ? {} : { estimatedCostUsd }),
  };
}

// ─── CLI flag helpers ─────────────────────────────────────────────────────────

function appendApprovalFlags(parts: string[], permissions: string | undefined, allowDangerousBypass = true): void {
  const mode = normalizePermissionMode(permissions);
  if (mode === 'permissionless') {
    if (allowDangerousBypass) {
      parts.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      parts.push('--ask-for-approval', 'never');
    }
  } else if (mode === 'auto-edit') {
    parts.push('--ask-for-approval', 'never');
  } else if (mode === 'suggest') {
    parts.push('--ask-for-approval', 'untrusted');
  }
}

function appendModelFlags(parts: string[], model: string | undefined): void {
  if (!model) return;
  parts.push('--model', shellEscape(model));
  if (/^o[34]/i.test(model)) {
    parts.push('-c', 'model_reasoning_effort=high');
  }
}

function appendNoUpdateCheckFlag(parts: string[]): void {
  parts.push('-c', 'check_for_update_on_startup=false');
}

function normalizePermissionMode(permissions: string | undefined): 'permissionless' | 'auto-edit' | 'suggest' {
  if (permissions === 'permissionless' || permissions === 'auto-edit' || permissions === 'suggest') {
    return permissions;
  }
  return 'auto-edit';
}

function currentTurnIdFromState(state: AppServerState): string | undefined {
  return state.currentTurnId ?? undefined;
}

function currentTurnIdFromParams(params: Record<string, unknown>): string | undefined {
  const turn = params['turn'] as Record<string, unknown> | undefined;
  const id = turn?.['id'];
  return typeof id === 'string' && id ? id : undefined;
}
