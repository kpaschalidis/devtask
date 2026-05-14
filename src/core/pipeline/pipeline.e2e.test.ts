import { describe, it, expect } from 'vitest';
import { createPipeline } from './pipeline.js';
import { implementPhase } from '../../phases/implement.js';
import { verifyPhase } from '../../phases/verify.js';
import { shipPhase } from '../../phases/ship.js';
import { silentLogger } from '../logging/index.js';
import type { AgentRunner, RunEvent, SessionHandle } from '../ports/agent-runner.js';
import type { RuntimeBackend, WorkspaceInfo } from '../ports/runtime-backend.js';
import type { WorkStore, TaskStore, ExecutionGraphStore, CoreStores } from '../ports/store.js';
import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { TaskPhase, TaskPhaseContext, PhaseOutcome } from './phase.js';

// ── In-memory stores ──────────────────────────────────────────────────────────

function createStores(): CoreStores {
  const works = new Map<string, Work>();
  const tasks = new Map<string, Task>();
  const graphs = new Map<string, ExecutionGraph>();

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
  const specMap = new Map<string, import('../domain/spec.js').Spec>();
  const specs = {
    save: (s: import('../domain/spec.js').Spec) => { specMap.set(s.id, s); specMap.set(`w:${s.workId}`, s); },
    getById: (id: string) => specMap.get(id) ?? null,
    getByWork: (workId: string) => specMap.get(`w:${workId}`) ?? null,
  };
  return { work, tasks: taskStore, graph, specs };
}

// ── Mock adapters ─────────────────────────────────────────────────────────────

function mockAgentRunner(events: RunEvent[] = [{ kind: 'completed' }]): AgentRunner {
  return {
    async start(): Promise<SessionHandle> {
      return { id: 'mock-session', threadId: 'mock-thread' };
    },
    async *run(): AsyncIterable<RunEvent> {
      for (const e of events) yield e;
    },
    async stop() {},
  };
}

function mockRuntimeBackend(scriptExitCode = 0): RuntimeBackend {
  return {
    async createWorkspace(workId, taskId, repoPath): Promise<WorkspaceInfo> {
      return { path: '/tmp/mock-workspace', workId, taskId, branch: 'mock-branch', repoPath };
    },
    async removeWorkspace() {},
    async runScript(): Promise<{ exitCode: number; output: string }> {
      return { exitCode: scriptExitCode, output: scriptExitCode === 0 ? 'ok' : 'FAIL' };
    },
  };
}

// ── Ship phase variant that completes without suspending ──────────────────────

const autoShipPhase: TaskPhase = {
  id: 'ship',
  async execute(_ctx: TaskPhaseContext): Promise<PhaseOutcome> { return 'completed'; },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function makeWork(id: string): Work {
  return { id, repoPaths: ['/repo'], title: 'Test work', description: null, status: 'pending', createdAt: ts(), updatedAt: ts() };
}

function makeTask(id: string, workId: string, opts: Partial<Task> = {}): Task {
  return { id, workId, repoPath: '/repo', title: 'Test task', description: 'Do the thing', status: 'pending', dependsOn: [], acceptanceCriteria: [], filesToCreate: [], filesToModify: [], phase: 1, createdAt: ts(), updatedAt: ts(), ...opts };
}

function makeGraph(workId: string, tasks: Task[]): ExecutionGraph {
  return { id: `g-${workId}`, workId, tasks, createdAt: ts(), approvedAt: null };
}

// ── Polling helper ────────────────────────────────────────────────────────────

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise(r => setTimeout(r, 50));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pipeline e2e', () => {
  it('runs a single task through implement → verify → ship (auto-approve)', async () => {
    const stores = createStores();
    const work = makeWork('w-1');
    const task = makeTask('t-1', 'w-1');
    stores.work.save(work);
    stores.tasks.save(task);
    stores.graph.save(makeGraph('w-1', [task]));

    const pipeline = createPipeline({
      workPhases: [],
      taskPhases: { implement: implementPhase, verify: verifyPhase, ship: autoShipPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-1');
    await waitFor(() => stores.work.getById('w-1')?.status === 'completed');

    expect(stores.tasks.getById('t-1')?.status).toBe('completed');
    expect(stores.work.getById('w-1')?.status).toBe('completed');
  });

  it('runs two independent tasks in parallel', async () => {
    const stores = createStores();
    const work = makeWork('w-2');
    const taskA = makeTask('t-a', 'w-2', { repoPath: '/repo/a' });
    const taskB = makeTask('t-b', 'w-2', { repoPath: '/repo/b' });
    stores.work.save(work);
    stores.tasks.save(taskA);
    stores.tasks.save(taskB);
    stores.graph.save(makeGraph('w-2', [taskA, taskB]));

    const pipeline = createPipeline({
      workPhases: [],
      taskPhases: { implement: implementPhase, verify: verifyPhase, ship: autoShipPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-2');
    await waitFor(() => stores.work.getById('w-2')?.status === 'completed');

    expect(stores.tasks.getById('t-a')?.status).toBe('completed');
    expect(stores.tasks.getById('t-b')?.status).toBe('completed');
  });

  it('suspends at ship review gate and completes after approval', async () => {
    const stores = createStores();
    const work = makeWork('w-3');
    const task = makeTask('t-3', 'w-3');
    stores.work.save(work);
    stores.tasks.save(task);
    stores.graph.save(makeGraph('w-3', [task]));

    const pipeline = createPipeline({
      workPhases: [],
      taskPhases: { implement: implementPhase, verify: verifyPhase, ship: shipPhase },
      ports: { agentRunner: mockAgentRunner(), runtimeBackend: mockRuntimeBackend(), publishProvider: null, ciProvider: null, contextProvider: null },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-3');

    await waitFor(() => stores.tasks.getById('t-3')?.status === 'gated');
    expect(stores.work.getById('w-3')?.status).toBe('running');

    await pipeline.resumeTask('t-3', 'ship', { approved: true });

    await waitFor(() => stores.work.getById('w-3')?.status === 'completed');
    expect(stores.tasks.getById('t-3')?.status).toBe('completed');
  });

  it('marks work failed when a task fails', async () => {
    const stores = createStores();
    const work = makeWork('w-4');
    const task = makeTask('t-4', 'w-4');
    stores.work.save(work);
    stores.tasks.save(task);
    stores.graph.save(makeGraph('w-4', [task]));

    const pipeline = createPipeline({
      workPhases: [],
      taskPhases: {
        implement: implementPhase,
        verify: verifyPhase,
        ship: autoShipPhase,
      },
      ports: {
        agentRunner: mockAgentRunner([{ kind: 'failed', error: 'boom' }]),
        runtimeBackend: mockRuntimeBackend(),
        publishProvider: null,
        ciProvider: null,
        contextProvider: null,
      },
      stores,
      logger: silentLogger(),
    });

    await pipeline.startWork('w-4');
    await waitFor(() => stores.work.getById('w-4')?.status === 'failed');

    expect(stores.tasks.getById('t-4')?.status).toBe('failed');
    expect(stores.work.getById('w-4')?.status).toBe('failed');
  });
});
