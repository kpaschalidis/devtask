import { describe, it, expect } from 'vitest';
import { createPipeline, } from './pipeline.js';
import { refinePhase } from '../../phases/refine.js';
import { architectPhase } from '../../phases/architect.js';
import { createGate } from './phase.js';
import { silentLogger } from '../logging/index.js';
import type { AgentRunner, RunEvent, SessionHandle } from '../ports/agent-runner.js';
import type { RuntimeBackend, WorkspaceInfo } from '../ports/runtime-backend.js';
import type { CoreStores, WorkStore, TaskStore, ExecutionGraphStore } from '../ports/store.js';
import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { Spec } from '../domain/spec.js';
import type { TaskPhase, TaskPhaseContext, PhaseOutcome, VerifyPhase, VerifyResult } from './phase.js';

// ── In-memory stores ──────────────────────────────────────────────────────────

function createStores(): CoreStores {
  const works = new Map<string, Work>();
  const tasks = new Map<string, Task>();
  const graphs = new Map<string, ExecutionGraph>();
  const specMap = new Map<string, Spec>();

  const work: WorkStore = {
    save: (w) => { works.set(w.id, w); },
    getById: (id) => works.get(id) ?? null,
    listActive: () => [...works.values()].filter(w => w.status !== 'completed' && w.status !== 'failed'),
  };
  const taskStore: TaskStore = {
    save: (t) => { tasks.set(t.id, t); },
    getById: (id) => tasks.get(id) ?? null,
    listByWork: (workId) => [...tasks.values()].filter(t => t.workId === workId),
  };
  const graph: ExecutionGraphStore = {
    save: (g) => { graphs.set(g.workId, g); },
    getByWork: (workId) => graphs.get(workId) ?? null,
  };
  const specs = {
    save: (s: Spec) => { specMap.set(s.id, s); specMap.set(`w:${s.workId}`, s); },
    getById: (id: string) => specMap.get(id) ?? null,
    getByWork: (workId: string) => specMap.get(`w:${workId}`) ?? null,
  };
  return { work, tasks: taskStore, graph, specs };
}

// ── Mock adapters ─────────────────────────────────────────────────────────────

function mockAgentRunner(events: RunEvent[] = [{ kind: 'completed' }]): AgentRunner {
  return {
    async start(): Promise<SessionHandle> { return { id: 'mock-session', threadId: 'mock-thread' }; },
    async *run(): AsyncIterable<RunEvent> { for (const e of events) yield e; },
    async stop() {},
  };
}

function mockRuntimeBackend(): RuntimeBackend {
  return {
    async createWorkspace(workId, taskId, repoPath): Promise<WorkspaceInfo> {
      return { path: '/tmp/mock-workspace', workId, taskId, branch: 'mock-branch', repoPath };
    },
    async removeWorkspace() {},
    async runScript(): Promise<{ exitCode: number; output: string }> {
      return { exitCode: 0, output: 'ok' };
    },
  };
}

const noopTaskPhase: TaskPhase = {
  id: 'noop',
  async execute(_ctx: TaskPhaseContext): Promise<PhaseOutcome> { return 'completed'; },
};

const noopVerifyPhase: VerifyPhase = {
  id: 'verify',
  async execute(_ctx: TaskPhaseContext): Promise<VerifyResult> { return { passed: true, output: '' }; },
};

function ts() { return new Date().toISOString(); }

function makeWork(id: string): Work {
  return { id, repoPaths: ['/repo'], title: 'Test', description: null, status: 'pending', createdAt: ts(), updatedAt: ts() };
}

function seedEmptyGraph(stores: CoreStores, workId: string): void {
  stores.graph.save({ id: `g-${workId}`, workId, tasks: [], createdAt: ts(), approvedAt: null });
}

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise(r => setTimeout(r, 50));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('refinePhase', () => {
  it('locks spec when agent outputs DONE_MARKER', async () => {
    const stores = createStores();
    const work = makeWork('w-1');
    stores.work.save(work);
    seedEmptyGraph(stores, 'w-1');

    const specOutput = '# Spec\nDo the thing\n<<<SPEC_COMPLETE>>>';
    const pipeline = createPipeline({
      workPhases: [refinePhase],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner([{ kind: 'output', text: specOutput }, { kind: 'completed' }]), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-1');
    await waitFor(() => stores.work.getById('w-1')?.status === 'completed');

    const spec = stores.specs.getByWork('w-1');
    expect(spec?.status).toBe('locked');
    expect(spec?.content).toContain('Do the thing');
  });

  it('suspends with questions when agent has no DONE_MARKER', async () => {
    const stores = createStores();
    const work = makeWork('w-2');
    stores.work.save(work);

    const pipeline = createPipeline({
      workPhases: [refinePhase],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner([{ kind: 'output', text: 'What is the scope?' }, { kind: 'completed' }]), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-2');
    await waitFor(() => stores.work.getById('w-2')?.pendingQuestions !== undefined);

    expect(stores.work.getById('w-2')?.pendingQuestions).toContain('What is the scope?');
    expect(stores.work.getById('w-2')?.status).toBe('refining');
  });
});

describe('createGate', () => {
  it('sets work status to gated and gateId on first execution', async () => {
    const stores = createStores();
    const work = makeWork('w-g1');
    stores.work.save(work);

    const gate = createGate('my-gate', () => ({ artifact: 'data' }));
    const pipeline = createPipeline({
      workPhases: [gate],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-g1');
    await waitFor(() => stores.work.getById('w-g1')?.status === 'gated');

    expect(stores.work.getById('w-g1')?.gateId).toBe('my-gate');
  });

  it('completes when approved', async () => {
    const stores = createStores();
    const work = makeWork('w-g2');
    stores.work.save(work);
    seedEmptyGraph(stores, 'w-g2');

    const gate = createGate('spec-gate', () => ({}));
    const pipeline = createPipeline({
      workPhases: [gate],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-g2');
    await waitFor(() => stores.work.getById('w-g2')?.status === 'gated');

    await pipeline.resumeWork('w-g2', 'spec-gate', { approved: true });
    await waitFor(() => stores.work.getById('w-g2')?.status === 'completed');

    expect(stores.work.getById('w-g2')?.gateId).toBeUndefined();
  });

  it('fails when rejected', async () => {
    const stores = createStores();
    const work = makeWork('w-g3');
    stores.work.save(work);

    const gate = createGate('spec-gate', () => ({}));
    const pipeline = createPipeline({
      workPhases: [gate],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-g3');
    await waitFor(() => stores.work.getById('w-g3')?.status === 'gated');

    await pipeline.resumeWork('w-g3', 'spec-gate', { approved: false });
    await waitFor(() => stores.work.getById('w-g3')?.status === 'failed');
  });
});

describe('architectPhase', () => {
  it('creates execution graph when agent outputs valid JSON plan', async () => {
    const stores = createStores();
    const work = makeWork('w-a1');
    stores.work.save(work);

    // Pre-seed a locked spec
    const spec: Spec = {
      id: 's-1', workId: 'w-a1', content: '# Spec', affectedRepoPaths: ['/repo'],
      qaHistory: [], status: 'locked', createdAt: ts(), updatedAt: ts(),
    };
    stores.specs.save(spec);

    const planJson = JSON.stringify({ tasks: [{ id: 't-1', title: 'Implement foo', repoPath: '/repo', description: 'Do it' }] });
    const agentOutput = `\`\`\`json\n${planJson}\n\`\`\`\n<<<PLAN_COMPLETE>>>`;

    const pipeline = createPipeline({
      workPhases: [architectPhase],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner([{ kind: 'output', text: agentOutput }, { kind: 'completed' }]), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    seedEmptyGraph(stores, 'w-a1');
    await pipeline.startWork('w-a1');
    await waitFor(() => stores.work.getById('w-a1')?.status === 'completed');

    const graph = stores.graph.getByWork('w-a1');
    expect(graph).not.toBeNull();
    expect(graph?.tasks).toHaveLength(1);
    expect(graph?.tasks[0]?.title).toBe('Implement foo');
  });

  it('fails when no locked spec exists', async () => {
    const stores = createStores();
    const work = makeWork('w-a2');
    stores.work.save(work);

    const pipeline = createPipeline({
      workPhases: [architectPhase],
      taskPhases: { implement: noopTaskPhase, verify: noopVerifyPhase, ship: noopTaskPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-a2');
    await waitFor(() => stores.work.getById('w-a2')?.status === 'failed');
  });
});
