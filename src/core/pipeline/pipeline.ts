import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { MastraCompositeStore, WorkflowsInMemory, InMemoryDB } from '@mastra/core/storage';
import { z } from 'zod';
import type { WorkPhase, TaskPhasesConfig, PipelineConfig, Pipeline, WorkPhaseContext, TaskPhaseContext } from './phase.js';
import { getReadyTasks, hasFailedTask } from './scheduler.js';
import type { TaskStatus } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import { CoreError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Zod schemas shared across task pipeline steps
// ---------------------------------------------------------------------------

const taskCtx = z.object({
  workId: z.string(),
  taskId: z.string(),
  workspacePath: z.string(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
});

const verifiedCtx = taskCtx.extend({
  passed: z.boolean(),
  verifyOutput: z.string(),
});

const suspendEnvelope = z.object({ payload: z.unknown() });
const resumeEnvelope = z.object({ data: z.unknown() });

// ---------------------------------------------------------------------------
// createPipeline — public factory
// ---------------------------------------------------------------------------

export function createPipeline(config: PipelineConfig): Pipeline {
  const { workPhases, taskPhases, stores, logger } = config;

  const mastra = buildMastra(workPhases, taskPhases, config);

  return {
    async startWork(workId: string) {
      const work = stores.work.getById(workId);
      if (!work) throw new CoreError(`Work not found: ${workId}`);

      const run = await mastra.getWorkflow('work-pipeline').createRun();
      stores.work.save({ ...work, mastraRunId: run.runId, updatedAt: now() });

      run.start({ inputData: { workId } }).catch((err: unknown) =>
        logger.error({ workId, err }, 'Work pipeline error'),
      );
    },

    async resumeWork(workId: string, phaseId: string, resumeData: unknown) {
      const work = stores.work.getById(workId);
      if (!work?.mastraRunId) throw new CoreError(`No active run for work: ${workId}`);
      const run = await mastra.getWorkflow('work-pipeline').createRun({ runId: work.mastraRunId });
      await run.resume({ step: phaseId, resumeData: { data: resumeData } });
    },

    async resumeTask(taskId: string, phaseId: string, resumeData: unknown) {
      const task = stores.tasks.getById(taskId);
      if (!task?.mastraRunId) throw new CoreError(`No active run for task: ${taskId}`);
      const run = await mastra.getWorkflow('task-pipeline').createRun({ runId: task.mastraRunId });
      const result = await run.resume({ step: phaseId, resumeData: { data: resumeData } });
      const current = stores.tasks.getById(taskId);
      if (current && result.status === 'success') {
        stores.tasks.save({ ...current, status: 'completed', updatedAt: now() });
      } else if (current && result.status === 'failed') {
        stores.tasks.save({ ...current, status: 'failed', updatedAt: now() });
      }
      // 'suspended' → stays 'gated', next resumeTask call will drive it forward
    },
  };
}

// ---------------------------------------------------------------------------
// Internal — Mastra instance + workflows
// ---------------------------------------------------------------------------

function buildMastra(
  workPhases: WorkPhase[],
  taskPhases: TaskPhasesConfig,
  config: PipelineConfig,
): Mastra {
  const db = new InMemoryDB();
  const workflowsStore = new WorkflowsInMemory({ db });
  const storage = new MastraCompositeStore({ id: 'devtask', domains: { workflows: workflowsStore } });

  const taskWorkflow = buildTaskWorkflow(taskPhases, config);
  const workWorkflow = buildWorkWorkflow(workPhases, config, storage);

  return new Mastra({ workflows: { 'work-pipeline': workWorkflow, 'task-pipeline': taskWorkflow }, storage });
}

// ---------------------------------------------------------------------------
// Work workflow — dynamic chain of work phases + exec
// ---------------------------------------------------------------------------

function buildWorkWorkflow(workPhases: WorkPhase[], config: PipelineConfig, storage: MastraCompositeStore) {
  const { stores, logger } = config;

  const execStep = createStep({
    id: 'exec',
    inputSchema: z.object({ workId: z.string() }).passthrough(),
    outputSchema: z.object({ workId: z.string(), success: z.boolean() }),
    execute: async ({ inputData }) => {
      const { workId } = inputData as { workId: string };
      const graph = stores.graph.getByWork(workId);
      if (!graph) throw new CoreError(`No execution graph for work: ${workId}`);

      const w = stores.work.getById(workId);
      if (w) stores.work.save({ ...w, status: 'running', updatedAt: now() });

      const mastra = new Mastra({
        workflows: { 'task-pipeline': buildTaskWorkflow(config.taskPhases, config) },
        storage,
      });

      const success = await runExecPhase(graph, mastra, stores, logger);

      const final = stores.work.getById(workId);
      if (final) stores.work.save({ ...final, status: success ? 'completed' : 'failed', updatedAt: now() });

      return { workId, success };
    },
  });

  // Build work phase steps
  const phaseSteps = workPhases.map((phase) => createWorkPhaseStep(phase, config));

  // Chain: phase0 → phase1 → ... → exec
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wf: any = createWorkflow({
    id: 'work-pipeline',
    inputSchema: z.object({ workId: z.string() }),
    outputSchema: z.object({ workId: z.string(), success: z.boolean() }),
  });

  for (const step of [...phaseSteps, execStep]) {
    wf = wf.then(step);
  }

  return wf.commit();
}

function createWorkPhaseStep(phase: WorkPhase, config: PipelineConfig) {
  const { stores, ports, logger } = config;

  return createStep({
    id: phase.id,
    inputSchema: z.object({ workId: z.string() }).passthrough(),
    outputSchema: z.object({ workId: z.string() }).passthrough(),
    suspendSchema: suspendEnvelope,
    resumeSchema: resumeEnvelope,
    execute: async ({ inputData, suspend, resumeData }) => {
      const { workId } = inputData as { workId: string };

      const ctx: WorkPhaseContext = {
        workId,
        stores,
        ports,
        resumeData: (resumeData as { data?: unknown } | null)?.data ?? null,
        suspend: async (payload) => { await suspend({ payload }); },
        logger,
      };

      const outcome = await phase.execute(ctx);
      if (outcome === 'failed') throw new Error(`Phase '${phase.id}' failed`);
      if (outcome === 'rejected') throw new Error(`Phase '${phase.id}' rejected`);

      return { ...inputData as object, workId };
    },
  });
}

// ---------------------------------------------------------------------------
// Task workflow — fixed structure, pluggable phase implementations
// ---------------------------------------------------------------------------

function buildTaskWorkflow(taskPhases: TaskPhasesConfig, config: PipelineConfig) {
  const { stores, ports, logger } = config;

  // ── implement ──────────────────────────────────────────────────────────────

  const implementStep = createStep({
    id: 'implement',
    inputSchema: z.object({ workId: z.string(), taskId: z.string() }),
    outputSchema: taskCtx,
    suspendSchema: suspendEnvelope,
    resumeSchema: resumeEnvelope,
    execute: async ({ inputData, suspend, resumeData }) => {
      const { workId, taskId } = inputData;
      const task = stores.tasks.getById(taskId);
      if (!task) throw new CoreError(`Task not found: ${taskId}`);

      const workspace = await ports.runtimeBackend.createWorkspace(workId, taskId, task.repoPath);

      const ctx: TaskPhaseContext = {
        workId, taskId,
        workspacePath: workspace.path,
        sessionHandle: task.sessionHandle,
        stores, ports,
        resumeData: (resumeData as { data?: unknown } | null)?.data ?? null,
        suspend: async (payload) => { await suspend({ payload }); },
        logger,
      };

      const outcome = await taskPhases.implement.execute(ctx);
      if (outcome === 'failed') throw new Error('Implement phase failed');

      const updated = stores.tasks.getById(taskId);
      return {
        workId, taskId,
        workspacePath: workspace.path,
        sessionId: updated?.sessionHandle?.id,
        threadId: updated?.sessionHandle?.threadId,
      };
    },
  });

  // ── verify ──────────────────────────────────────────────────────────────────

  const verifyStep = createStep({
    id: 'verify',
    inputSchema: taskCtx,
    outputSchema: verifiedCtx,
    execute: async ({ inputData }) => {
      const { workId, taskId, workspacePath } = inputData;
      const task = stores.tasks.getById(taskId);
      if (!task) throw new CoreError(`Task not found: ${taskId}`);

      const ctx: TaskPhaseContext = {
        workId, taskId, workspacePath,
        sessionHandle: task.sessionHandle,
        stores, ports,
        resumeData: null,
        suspend: async () => {},
        logger,
      };

      const result = await taskPhases.verify.execute(ctx);
      return { ...inputData, passed: result.passed, verifyOutput: result.output };
    },
  });

  // ── fix (used in dountil — runs implement in fix mode, then verify) ─────────

  const fixStep = createStep({
    id: 'fix',
    inputSchema: verifiedCtx,
    outputSchema: verifiedCtx,
    execute: async ({ inputData }) => {
      if (inputData.passed) return inputData;

      const { workId, taskId, workspacePath, verifyOutput } = inputData;
      const task = stores.tasks.getById(taskId);
      if (!task) throw new CoreError(`Task not found: ${taskId}`);

      const fixCtx: TaskPhaseContext = {
        workId, taskId, workspacePath,
        sessionHandle: task.sessionHandle,
        verifyOutput,
        stores, ports,
        resumeData: null,
        suspend: async () => {},
        logger,
      };

      await taskPhases.implement.execute(fixCtx);

      const verifyCtx: TaskPhaseContext = {
        workId, taskId, workspacePath,
        sessionHandle: stores.tasks.getById(taskId)?.sessionHandle,
        stores, ports,
        resumeData: null,
        suspend: async () => {},
        logger,
      };

      const result = await taskPhases.verify.execute(verifyCtx);
      return { ...inputData, passed: result.passed, verifyOutput: result.output };
    },
  });

  // ── ship ────────────────────────────────────────────────────────────────────

  const shipStep = createStep({
    id: 'ship',
    inputSchema: verifiedCtx,
    outputSchema: z.object({ prUrl: z.string() }),
    suspendSchema: suspendEnvelope,
    resumeSchema: resumeEnvelope,
    execute: async ({ inputData, suspend, resumeData }) => {
      const { workId, taskId, workspacePath } = inputData;
      const task = stores.tasks.getById(taskId);
      if (!task) throw new CoreError(`Task not found: ${taskId}`);

      const ctx: TaskPhaseContext = {
        workId, taskId, workspacePath,
        sessionHandle: task.sessionHandle,
        stores, ports,
        resumeData: (resumeData as { data?: unknown } | null)?.data ?? null,
        suspend: async (payload) => { await suspend({ payload }); },
        logger,
      };

      const outcome = await taskPhases.ship.execute(ctx);
      if (outcome === 'failed') throw new Error('Ship phase failed');
      if (outcome === 'rejected') return { prUrl: '' };

      return { prUrl: '' };
    },
  });

  return createWorkflow({
    id: 'task-pipeline',
    inputSchema: z.object({ workId: z.string(), taskId: z.string() }),
    outputSchema: z.object({ prUrl: z.string() }),
  })
    .then(implementStep)
    .then(verifyStep)
    .dountil(fixStep, async ({ inputData }) => inputData?.passed ?? true)
    .then(shipStep)
    .commit();
}

// ---------------------------------------------------------------------------
// Exec phase — scheduler driving task pipeline runs
// ---------------------------------------------------------------------------

async function runExecPhase(
  graph: ExecutionGraph,
  mastra: Mastra,
  stores: { work: import('../ports/store.js').WorkStore; tasks: import('../ports/store.js').TaskStore; graph: import('../ports/store.js').ExecutionGraphStore },
  logger: import('../logging/index.js').Logger,
): Promise<boolean> {
  const states = new Map<string, TaskStatus>();
  const inFlight = new Set<Promise<void>>();

  const startReady = () => {
    for (const task of getReadyTasks(graph, states)) {
      states.set(task.id, 'running');
      stores.tasks.save({ ...task, status: 'running', updatedAt: now() });

      const p: Promise<void> = runOneTask(task.id, task.workId, mastra, stores).then(
        (status) => { states.set(task.id, status); inFlight.delete(p); },
        (err: unknown) => {
          logger.error({ taskId: task.id, err }, 'Task crashed');
          states.set(task.id, 'failed');
          stores.tasks.save({ ...stores.tasks.getById(task.id)!, status: 'failed', updatedAt: now() });
          inFlight.delete(p);
        },
      );
      inFlight.add(p);
    }
  };

  startReady();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    startReady();
  }

  return !hasFailedTask(graph, states);
}

async function runOneTask(
  taskId: string,
  workId: string,
  mastra: Mastra,
  stores: { tasks: import('../ports/store.js').TaskStore },
): Promise<TaskStatus> {
  const task = stores.tasks.getById(taskId);
  if (!task) throw new CoreError(`Task not found: ${taskId}`);

  const run = await mastra.getWorkflow('task-pipeline').createRun();
  stores.tasks.save({ ...task, mastraRunId: run.runId, status: 'running', updatedAt: now() });

  const result = await run.start({ inputData: { workId, taskId } });

  if (result.status === 'suspended') {
    stores.tasks.save({ ...stores.tasks.getById(taskId)!, status: 'gated', updatedAt: now() });
    return waitForTaskCompletion(taskId, stores);
  }

  const finalStatus: TaskStatus = result.status === 'success' ? 'completed' : 'failed';
  stores.tasks.save({ ...stores.tasks.getById(taskId)!, status: finalStatus, updatedAt: now() });
  return finalStatus;
}

function waitForTaskCompletion(
  taskId: string,
  stores: { tasks: import('../ports/store.js').TaskStore },
): Promise<TaskStatus> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const t = stores.tasks.getById(taskId);
      if (t?.status === 'completed' || t?.status === 'failed') {
        clearInterval(poll);
        resolve(t.status);
      }
    }, 2_000);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}
