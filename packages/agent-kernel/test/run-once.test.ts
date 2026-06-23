import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import type { Runtime, RuntimeHandle } from '../src/runtime/runtime.js';
import { runOnce } from '../src/control/run-once.js';
import { SessionCoordinator } from '../src/sessions/session-coordinator.js';
import { InMemorySessionHistoryStore } from '../src/trace/in-memory-session-history-store.js';
import { SessionHistoryCaptureService } from '../src/trace/session-history-capture-service.js';
import { NoopWorkspaceSetup } from '../src/workspace/workspace-setup.js';

describe('runOnce', () => {
  it('returns completed status, forwards events, and closes the thread', async () => {
    const events: string[] = [];
    const fixture = createFixture({
      sendMessage: vi.fn(async () => {}),
      readEvents: async function* () {
        yield { kind: 'output', text: 'hello' } as const;
        yield { kind: 'completed' } as const;
      },
      getSessionInfo: vi.fn(async () => ({
        summary: 'done',
        summaryIsFallback: true,
        agentSessionId: 'thread-1',
      })),
    });

    const result = await runOnce({
      coordinator: fixture.coordinator,
      workspacePath: process.cwd(),
      prompt: 'build it',
      owner: owner(),
      onEvent: (event) => events.push(event.kind),
    });

    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.sessionInfo?.summary).toBe('done');
    expect(events).toEqual(['output', 'completed']);
    expect(fixture.store.listThreads()[0]?.status).toBe('completed');
  });

  it('returns failed status and closes the thread as failed', async () => {
    const fixture = createFixture({
      sendMessage: vi.fn(async () => {}),
      readEvents: async function* () {
        yield { kind: 'failed', error: 'boom' } as const;
      },
    });

    const result = await runOnce({
      coordinator: fixture.coordinator,
      workspacePath: process.cwd(),
      prompt: 'build it',
      owner: owner(),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(fixture.store.listThreads()[0]?.status).toBe('failed');
  });
});

function createFixture(overrides: Partial<Agent>) {
  const store = new InMemorySessionHistoryStore();
  const agent: Agent = {
    name: 'test',
    promptDelivery: 'post-launch',
    getLaunchCommand: async () => 'true',
    getEnvironment: () => ({}),
    createSession: async (input) => handle(input.sessionId),
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
  return { coordinator, store };
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
