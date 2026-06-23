import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentCreateSessionInput, AgentRestoreSessionInput } from '../src/agent/agent.js';
import type { Runtime, RuntimeHandle } from '../src/runtime/runtime.js';
import { SessionCoordinator } from '../src/sessions/session-coordinator.js';
import { InMemorySessionHistoryStore } from '../src/trace/in-memory-session-history-store.js';
import { SessionHistoryCaptureService } from '../src/trace/session-history-capture-service.js';
import { NoopWorkspaceSetup } from '../src/workspace/workspace-setup.js';

describe('SessionCoordinator lifecycle', () => {
  it('preserves events emitted before createSession returns', async () => {
    const fixture = createFixture({
      createSession: async (input) => {
        input.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', text: 'early' });
        await Promise.resolve();
        input.onHistoryEvent?.({ type: 'message.completed', role: 'assistant' });
        return handle(input.sessionId);
      },
    });

    await fixture.coordinator.startSession(startInput());
    expect(fixture.store.listEvents(fixture.threadId()).map((event) => event.type)).toContain('message.delta');
    expect(fixture.store.listTranscript({ owner: owner() })[0]?.content).toBe('early');
  });

  it('does not persist provider events when creation fails', async () => {
    const fixture = createFixture({
      createSession: async (input) => {
        input.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', text: 'discard me' });
        throw new Error('creation failed');
      },
    });

    await expect(fixture.coordinator.startSession(startInput())).rejects.toThrow('creation failed');
    expect(fixture.store.listThreads()).toHaveLength(0);
  });

  it('buffers restore events and attaches the replacement runtime', async () => {
    let restoredInput: AgentRestoreSessionInput | null = null;
    const fixture = createFixture({
      createSession: async (input) => handle(input.sessionId),
      restoreSession: async (input) => {
        restoredInput = input;
        input.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', text: 'restored' });
        return handle(input.sessionId);
      },
    });
    const original = await fixture.coordinator.startSession(startInput());
    const restored = await fixture.coordinator.restoreSession({
      ...startInput(),
      sessionId: 'runtime-2',
      previousHandle: original,
    });

    expect(restored?.id).toBe('runtime-2');
    expect(fixture.store.listEvents(fixture.threadId()).some((event) => event.payload['text'] === 'restored')).toBe(true);
    restoredInput!.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', text: 'later' });
    expect(fixture.store.listEvents(fixture.threadId()).some((event) => event.payload['text'] === 'later')).toBe(true);
  });

  it('does not persist restore events when restoration fails', async () => {
    const fixture = createFixture({
      createSession: async (input) => handle(input.sessionId),
      restoreSession: async (input) => {
        input.onHistoryEvent?.({ type: 'message.delta', role: 'assistant', text: 'discard restore' });
        throw new Error('restore failed');
      },
    });
    const original = await fixture.coordinator.startSession(startInput());
    await expect(fixture.coordinator.restoreSession({
      ...startInput(),
      sessionId: 'runtime-2',
      previousHandle: original,
    })).rejects.toThrow('restore failed');
    expect(fixture.store.listEvents(fixture.threadId()).some((event) => event.payload['text'] === 'discard restore')).toBe(false);
  });

  it('closes history and releases resources on interruption', async () => {
    const release = vi.fn();
    const fixture = createFixture({
      createSession: async (input) => handle(input.sessionId),
      cancelTurn: async () => ({ mode: 'hard' }),
      release,
    });
    const active = await fixture.coordinator.startSession(startInput());
    await fixture.coordinator.interruptSession(active);
    expect(fixture.store.getThread(fixture.threadId())?.status).toBe('abandoned');
    expect(release).toHaveBeenCalledWith(active);
  });
});

function createFixture(overrides: Partial<Agent>) {
  const store = new InMemorySessionHistoryStore();
  const agent: Agent = {
    name: 'test',
    promptDelivery: 'post-launch',
    getLaunchCommand: async () => 'true',
    getEnvironment: () => ({}),
    readEvents: async function* () {},
    ...overrides,
  };
  const runtime: Runtime = {
    name: 'test-runtime',
    create: async (input) => handle(input.sessionId),
    destroy: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isAlive: vi.fn(async () => true),
  };
  const coordinator = new SessionCoordinator({
    agent,
    runtime,
    workspaceSetup: new NoopWorkspaceSetup(),
    sessionHistory: new SessionHistoryCaptureService(store),
    logger: { warn: vi.fn() },
  });
  return {
    coordinator,
    store,
    threadId: () => store.listThreads()[0]!.id,
  };
}

function startInput() {
  return {
    sessionId: 'runtime-1',
    workspacePath: process.cwd(),
    owner: owner(),
    instructions: { persistentInstructions: 'test instructions' },
  };
}

function owner() {
  return {
    type: 'phase-task',
    id: 'task-1',
    parent: { type: 'work', id: 'work-1' },
  };
}

function handle(id: string): RuntimeHandle {
  return { id, runtimeName: 'test', data: {} };
}
