import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RuntimeBackend } from '../ports/runtime-backend.js';
import type { CoreStores } from '../ports/store.js';
import type { Logger } from '../logging/index.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { TaskStatus } from '../domain/task.js';
import { getReadyTasks, hasFailedTask } from './scheduler.js';
import { CoreError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Spec provider — produces the execution graph for a work item
// ---------------------------------------------------------------------------

export interface SpecProvider {
  spec(workId: string, title: string, description: string | null, repoPath: string): Promise<ExecutionGraph>;
}

// ---------------------------------------------------------------------------
// Orchestrator ports
// ---------------------------------------------------------------------------

export interface OrchestratorPorts {
  agentRunner: AgentRunner;
  runtimeBackend: RuntimeBackend;
  specProvider: SpecProvider;
}

// ---------------------------------------------------------------------------
// Work orchestrator
//
// Drives the work-level pipeline:
//   spec stage → (gate) → exec phase (tasks run in parallel via Mastra) → done
// ---------------------------------------------------------------------------

export class WorkOrchestrator {
  private readonly mastra: Mastra;

  constructor(
    private readonly stores: CoreStores,
    private readonly logger: Logger,
    mastra: Mastra,
  ) {
    this.mastra = mastra;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async startWork(workId: string): Promise<void> {
    const work = this.stores.work.getById(workId);
    if (!work) throw new CoreError(`Work not found: ${workId}`);

    const run = await this.mastra.getWorkflow('work-pipeline').createRun();
    this.stores.work.save({ ...work, mastraRunId: run.runId, status: 'speccing', updatedAt: now() });

    run.start({ inputData: { workId } }).catch((err: unknown) =>
      this.logger.error({ workId, err }, 'Work pipeline error'),
    );
  }

  async approveSpec(workId: string): Promise<void> {
    const run = await this.getWorkRun(workId);
    await run.resume({ step: 'spec', resumeData: { approved: true } });
  }

  async rejectSpec(workId: string): Promise<void> {
    const run = await this.getWorkRun(workId);
    await run.resume({ step: 'spec', resumeData: { approved: false } });
  }

  async answerTaskQuestion(taskId: string, answer: string): Promise<void> {
    const task = this.stores.tasks.getById(taskId);
    if (!task?.mastraRunId) throw new CoreError(`No active run for task: ${taskId}`);
    const run = await this.mastra.getWorkflow('task-pipeline').createRun({ runId: task.mastraRunId });
    if (!task.sessionHandle) throw new CoreError(`No session handle on task: ${taskId}`);
    await run.resume({
      step: 'run',
      resumeData: {
        answer,
        sessionId: task.sessionHandle.id,
        threadId: task.sessionHandle.threadId,
      },
    });
  }

  async approveTaskReview(taskId: string): Promise<void> {
    const run = await this.getTaskRun(taskId);
    await run.resume({ step: 'review', resumeData: { approved: true } });
  }

  async rejectTaskReview(taskId: string): Promise<void> {
    const run = await this.getTaskRun(taskId);
    await run.resume({ step: 'review', resumeData: { approved: false } });
  }

  // ── Workflow registration ──────────────────────────────────────────────────

  static buildWorkflow(stores: CoreStores, ports: OrchestratorPorts, mastra: Mastra, logger: Logger) {
    return buildWorkPipelineWorkflow(stores, ports, mastra, logger);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getWorkRun(workId: string) {
    const work = this.stores.work.getById(workId);
    if (!work?.mastraRunId) throw new CoreError(`No active run for work: ${workId}`);
    return this.mastra.getWorkflow('work-pipeline').createRun({ runId: work.mastraRunId });
  }

  private async getTaskRun(taskId: string) {
    const task = this.stores.tasks.getById(taskId);
    if (!task?.mastraRunId) throw new CoreError(`No active run for task: ${taskId}`);
    return this.mastra.getWorkflow('task-pipeline').createRun({ runId: task.mastraRunId });
  }
}

// ---------------------------------------------------------------------------
// Work pipeline workflow
// ---------------------------------------------------------------------------

function buildWorkPipelineWorkflow(
  stores: CoreStores,
  ports: OrchestratorPorts,
  mastra: Mastra,
  logger: Logger,
) {
  // ── spec step ─────────────────────────────────────────────────────────────
  // Runs the spec agent to decompose the work into tasks.
  // Suspends for a human review gate after speccing is done.

  const specStep = createStep({
    id: 'spec',
    inputSchema: z.object({ workId: z.string() }),
    outputSchema: z.object({ workId: z.string(), taskCount: z.number() }),
    suspendSchema: z.object({ reason: z.string() }),
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, suspend, resumeData }) => {
      const { workId } = inputData;
      const work = stores.work.getById(workId);
      if (!work) throw new CoreError(`Work not found: ${workId}`);

      if (resumeData) {
        if (!resumeData.approved) {
          stores.work.save({ ...work, status: 'failed', updatedAt: now() });
          throw new Error('Spec rejected');
        }
        stores.work.save({ ...work, status: 'running', updatedAt: now() });
        const taskCount = stores.tasks.listByWork(workId).length;
        return { workId, taskCount };
      }

      stores.work.save({ ...work, status: 'speccing', updatedAt: now() });

      const graph = await ports.specProvider.spec(workId, work.title, work.description, work.repoPath);
      stores.graph.save(graph);
      for (const task of graph.tasks) {
        stores.tasks.save(task);
      }

      stores.work.save({ ...work, status: 'gated', updatedAt: now() });
      await suspend({ reason: 'Review the generated task plan before starting execution' });
      return { workId, taskCount: graph.tasks.length };
    },
  });

  // ── exec step ─────────────────────────────────────────────────────────────
  // Drives the task scheduler: starts independent Mastra runs per task,
  // respecting dependency ordering and per-repo serialization.

  const execStep = createStep({
    id: 'exec',
    inputSchema: z.object({ workId: z.string(), taskCount: z.number() }),
    outputSchema: z.object({ workId: z.string(), success: z.boolean() }),
    execute: async ({ inputData }) => {
      const { workId } = inputData;
      const graph = stores.graph.getByWork(workId);
      if (!graph) throw new CoreError(`No execution graph for work: ${workId}`);

      stores.work.save({ ...stores.work.getById(workId)!, status: 'running', updatedAt: now() });

      const success = await runExecPhase(graph, mastra, stores, logger);

      const finalStatus = success ? 'completed' : 'failed';
      stores.work.save({ ...stores.work.getById(workId)!, status: finalStatus, updatedAt: now() });
      return { workId, success };
    },
  });

  // ── workflow ──────────────────────────────────────────────────────────────

  return createWorkflow({
    id: 'work-pipeline',
    inputSchema: z.object({ workId: z.string() }),
    outputSchema: z.object({ workId: z.string(), success: z.boolean() }),
  })
    .then(specStep)
    .then(execStep)
    .commit();
}

// ---------------------------------------------------------------------------
// Exec phase — drives task pipeline runs via the scheduler
// ---------------------------------------------------------------------------

async function runExecPhase(
  graph: ExecutionGraph,
  mastra: Mastra,
  stores: CoreStores,
  logger: Logger,
): Promise<boolean> {
  const states = new Map<string, TaskStatus>();
  const inFlight = new Set<Promise<void>>();

  const startReady = () => {
    for (const task of getReadyTasks(graph, states)) {
      states.set(task.id, 'running');
      stores.tasks.save({ ...task, status: 'running', updatedAt: now() });

      const p: Promise<void> = startTaskRun(task.id, task.workId, mastra, stores).then(
        (taskStatus) => {
          states.set(task.id, taskStatus);
          inFlight.delete(p);
        },
        (err: unknown) => {
          logger.error({ taskId: task.id, err }, 'Task run crashed');
          states.set(task.id, 'failed');
          stores.tasks.save({ ...task, status: 'failed', updatedAt: now() });
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

async function startTaskRun(
  taskId: string,
  workId: string,
  mastra: Mastra,
  stores: CoreStores,
): Promise<TaskStatus> {
  const task = stores.tasks.getById(taskId);
  if (!task) throw new CoreError(`Task not found: ${taskId}`);

  const run = await mastra.getWorkflow('task-pipeline').createRun();
  stores.tasks.save({ ...task, mastraRunId: run.runId, status: 'running', updatedAt: now() });

  const result = await run.start({ inputData: { workId, taskId } });

  if (result.status === 'suspended') {
    // Task is waiting for human input (agent question or review gate).
    // The task stays in 'gated' state; the orchestrator's resume methods
    // will drive it forward when the human responds.
    stores.tasks.save({ ...stores.tasks.getById(taskId)!, status: 'gated', updatedAt: now() });

    // Wait for the task to finish (resume will be called externally).
    return new Promise<TaskStatus>((resolve) => {
      const poll = setInterval(() => {
        const t = stores.tasks.getById(taskId);
        if (t?.status === 'completed' || t?.status === 'failed') {
          clearInterval(poll);
          resolve(t.status);
        }
      }, 2_000);
    });
  }

  const finalStatus = result.status === 'success' ? 'completed' : 'failed';
  stores.tasks.save({ ...stores.tasks.getById(taskId)!, status: finalStatus, updatedAt: now() });
  return finalStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}
