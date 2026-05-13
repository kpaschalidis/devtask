import crypto from 'node:crypto';
import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { StageAttempt } from '../domain/stage-attempt.js';
import type { Gate, GateDecision } from '../domain/gate.js';
import type { AgentQuestion } from '../domain/agent-question.js';
import type { WorkStore, TaskStore, ExecutionGraphStore, StageAttemptStore, RunAttemptStore, ArtifactStore, GateStore, AgentQuestionStore } from '../ports/store.js';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RuntimeBackend } from '../ports/runtime-backend.js';
import type { PublishProvider } from '../ports/publish-provider.js';
import type { CiProvider } from '../ports/ci-provider.js';
import type { ContextProvider } from '../ports/context-provider.js';
import type { EventStore } from '../events/store.js';
import type { DomainEvent } from '../events/domain-events.js';
import type { Logger } from '../logging/index.js';
import type { WorkflowConfig, WorkflowDefinition } from './workflow-definition.js';
import type { StageContext, StageResult } from './stage-handler.js';
import { HandlerRegistry } from './handler-registry.js';
import { getStageDefinition } from './stage-machine.js';
import { getReadyTasks, hasFailedTask } from './scheduler.js';
import { InMemoryEventBus } from './event-bus.js';
import { CoreError } from '../errors/index.js';

export interface EngineStores {
  work: WorkStore;
  tasks: TaskStore;
  graph: ExecutionGraphStore;
  stages: StageAttemptStore;
  runs: RunAttemptStore;
  artifacts: ArtifactStore;
  gates: GateStore;
  questions: AgentQuestionStore;
}

export interface EnginePorts {
  agentRunner: AgentRunner;
  runtimeBackend: RuntimeBackend;
  publishProvider: PublishProvider | null;
  ciProvider: CiProvider | null;
  contextProvider: ContextProvider;
}

export class WorkflowEngine {
  private readonly pendingGates = new Map<string, (decision: GateDecision) => void>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  // Tracks open gates by ID for event emission on close
  private readonly activeGates = new Map<string, Gate>();

  constructor(
    private readonly config: WorkflowConfig,
    private readonly handlers: HandlerRegistry,
    private readonly stores: EngineStores,
    private readonly eventStore: EventStore,
    private readonly eventBus: InMemoryEventBus,
    private readonly ports: EnginePorts,
    private readonly logger: Logger,
  ) {}

  async startWork(workId: string): Promise<void> {
    const work = this.stores.work.getById(workId);
    if (!work) throw new CoreError(`Work not found: ${workId}`);
    this.runWorkPipeline(workId).catch((err) =>
      this.logger.error({ workId, err }, 'Work pipeline error'),
    );
  }

  async approveGate(gateId: string, decidedBy: string): Promise<void> {
    this.resolveGate(gateId, decidedBy, 'approved');
  }

  async rejectGate(gateId: string, decidedBy: string): Promise<void> {
    this.resolveGate(gateId, decidedBy, 'rejected');
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    this.pendingQuestions.get(questionId)?.(answer);
    this.pendingQuestions.delete(questionId);
  }

  private resolveGate(gateId: string, decidedBy: string, decision: GateDecision): void {
    const gate = this.activeGates.get(gateId);
    if (!gate) throw new CoreError(`No open gate found: ${gateId}`);

    const closed: Gate = { ...gate, closedAt: this.now(), closedBy: decidedBy, decision };
    this.stores.gates.save(closed);
    this.activeGates.delete(gateId);

    this.emit({
      kind: 'gate_closed',
      workId: gate.workId,
      taskId: gate.taskId,
      stage: gate.stage,
      gateId,
      decision,
      ts: Date.now(),
    });

    this.pendingGates.get(gateId)?.(decision);
    this.pendingGates.delete(gateId);
  }

  private async runWorkPipeline(workId: string): Promise<void> {
    const pipeline = this.config.workPipeline;
    let stage: string | null = pipeline.entry;
    let attemptsOnCurrentStage = 0;

    this.updateWorkStatus(workId, 'speccing');

    while (stage) {
      const def = getStageDefinition(pipeline, stage);
      attemptsOnCurrentStage++;

      const outcome = await this.runOneStage(workId, null, stage, pipeline);

      if (outcome === 'needs_input') {
        // Stage suspended for human input; retry without counting as failure
        attemptsOnCurrentStage--;
        continue;
      }

      if (outcome === 'completed') {
        const transition = def.onSuccess;
        if ('done' in transition) {
          this.updateWorkStatus(workId, 'completed');
          break;
        } else if ('fail' in transition) {
          this.updateWorkStatus(workId, 'failed');
          break;
        } else {
          attemptsOnCurrentStage = 0;
          stage = transition.goto;
          if (stage === 'exec') this.updateWorkStatus(workId, 'running');
        }
      } else {
        const maxAttempts = def.maxAttempts ?? 1;
        if (attemptsOnCurrentStage < maxAttempts) continue;

        const transition = def.onFailure;
        if ('done' in transition) {
          this.updateWorkStatus(workId, 'completed');
          break;
        } else if ('fail' in transition) {
          this.updateWorkStatus(workId, 'failed');
          break;
        } else {
          attemptsOnCurrentStage = 0;
          stage = transition.goto;
        }
      }
    }
  }

  private async runTaskPipeline(workId: string, taskId: string): Promise<void> {
    const pipeline = this.config.taskPipeline;
    let stage: string | null = pipeline.entry;
    let attemptsOnCurrentStage = 0;

    while (stage) {
      const def = getStageDefinition(pipeline, stage);
      attemptsOnCurrentStage++;

      const outcome = await this.runOneStage(workId, taskId, stage, pipeline);

      if (outcome === 'needs_input') {
        attemptsOnCurrentStage--;
        continue;
      }

      if (outcome === 'completed') {
        const transition = def.onSuccess;
        if ('done' in transition) {
          this.updateTaskStatus(workId, taskId, 'completed');
          break;
        } else if ('fail' in transition) {
          this.updateTaskStatus(workId, taskId, 'failed');
          break;
        } else {
          if (transition.goto !== stage) attemptsOnCurrentStage = 0;
          stage = transition.goto;
        }
      } else {
        const maxAttempts = def.maxAttempts ?? 1;
        if (attemptsOnCurrentStage < maxAttempts) continue;

        const transition = def.onFailure;
        if ('done' in transition) {
          this.updateTaskStatus(workId, taskId, 'completed');
          break;
        } else if ('fail' in transition) {
          this.updateTaskStatus(workId, taskId, 'failed');
          break;
        } else {
          if (transition.goto !== stage) attemptsOnCurrentStage = 0;
          stage = transition.goto;
        }
      }
    }
  }

  // Drives all tasks in an execution graph, respecting dependencies and repo constraints.
  private async runExecPhase(workId: string): Promise<boolean> {
    const graph = this.stores.graph.getByWork(workId);
    if (!graph) throw new CoreError(`No execution graph for work: ${workId}`);

    const states = new Map<string, 'running' | 'completed' | 'failed'>();
    const inFlight = new Set<Promise<void>>();

    const startReady = () => {
      for (const task of getReadyTasks(graph, states)) {
        states.set(task.id, 'running');
        const p: Promise<void> = this.runTaskPipeline(workId, task.id).then(
          () => {
            const t = this.stores.tasks.getById(task.id);
            states.set(task.id, t?.status === 'completed' ? 'completed' : 'failed');
            inFlight.delete(p);
          },
          () => {
            states.set(task.id, 'failed');
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

  private async runOneStage(
    workId: string,
    taskId: string | null,
    stage: string,
    pipeline: WorkflowDefinition,
  ): Promise<'completed' | 'failed' | 'needs_input'> {
    const work = this.stores.work.getById(workId);
    if (!work) throw new CoreError(`Work not found: ${workId}`);

    const task: Task | null = taskId ? (this.stores.tasks.getById(taskId) ?? null) : null;
    const def = getStageDefinition(pipeline, stage);

    const prevCount = this.stores.stages
      .listByWork(workId)
      .filter((a) => a.taskId === taskId && a.stage === stage).length;

    const attempt: StageAttempt = {
      id: this.newId(),
      workId,
      taskId,
      stage,
      attemptNumber: prevCount + 1,
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      failureReason: null,
    };

    this.stores.stages.save(attempt);
    this.emit({ kind: 'stage_started', workId, taskId, stage, attemptId: attempt.id, ts: Date.now() });

    // The exec handler is a compound stage — it drives the task scheduler loop
    if (def.handler === 'exec') {
      const success = await this.runExecPhase(workId);
      const finishedAttempt: StageAttempt = {
        ...attempt,
        status: success ? 'completed' : 'failed',
        finishedAt: this.now(),
        failureReason: success ? null : 'One or more tasks failed',
      };
      this.stores.stages.save(finishedAttempt);
      if (success) {
        this.emit({ kind: 'stage_completed', workId, taskId, stage, attemptId: attempt.id, ts: Date.now() });
      } else {
        this.emit({ kind: 'stage_failed', workId, taskId, stage, attemptId: attempt.id, reason: 'One or more tasks failed', ts: Date.now() });
      }
      return success ? 'completed' : 'failed';
    }

    const handler = this.handlers.get(def.handler);
    const artifacts = this.stores.artifacts.listByTask(workId, taskId);
    const ctx: StageContext = {
      work,
      task,
      attempt,
      artifacts,
      ports: this.ports,
    };

    let result: StageResult;
    try {
      result = await handler.execute(ctx);
    } catch (err) {
      result = { outcome: 'failed', reason: String(err) };
    }

    if (result.outcome === 'failed') {
      const failed: StageAttempt = {
        ...attempt,
        status: 'failed',
        finishedAt: this.now(),
        failureReason: result.reason,
      };
      this.stores.stages.save(failed);
      this.emit({ kind: 'stage_failed', workId, taskId, stage, attemptId: attempt.id, reason: result.reason, ts: Date.now() });
      return 'failed';
    }

    if (result.outcome === 'needs_input') {
      const gated: StageAttempt = { ...attempt, status: 'gated' };
      this.stores.stages.save(gated);

      const question: AgentQuestion = {
        id: this.newId(),
        workId,
        taskId,
        runAttemptId: attempt.id,
        question: result.question,
        answer: null,
        askedAt: this.now(),
        answeredAt: null,
      };
      this.stores.questions.save(question);
      this.emit({ kind: 'agent_question_asked', workId, runAttemptId: attempt.id, questionId: question.id, question: result.question, ts: Date.now() });

      const answer = await new Promise<string>((resolve) => {
        this.pendingQuestions.set(question.id, resolve);
      });

      this.stores.questions.save({ ...question, answer, answeredAt: this.now() });
      this.emit({ kind: 'agent_question_answered', workId, runAttemptId: attempt.id, questionId: question.id, ts: Date.now() });

      // Stage must be re-run with answer in context; signal the pipeline runner
      this.stores.stages.save({ ...gated, status: 'failed', finishedAt: this.now(), failureReason: 'needs_input' });
      return 'needs_input';
    }

    // outcome === 'completed'
    for (const artifact of result.artifacts) {
      this.stores.artifacts.save(artifact);
      this.emit({ kind: 'artifact_produced', workId, taskId, stage, artifactId: artifact.id, ts: Date.now() });
    }

    if (def.gate === 'required') {
      const gate: Gate = {
        id: this.newId(),
        workId,
        taskId,
        stage,
        reason: `Approval required before advancing from '${stage}'`,
        openedAt: this.now(),
        closedAt: null,
        closedBy: null,
        decision: null,
      };
      this.stores.gates.save(gate);
      this.activeGates.set(gate.id, gate);
      const gated: StageAttempt = { ...attempt, status: 'gated' };
      this.stores.stages.save(gated);
      this.updateWorkOrTaskStatus(workId, taskId, 'gated');
      this.emit({ kind: 'gate_opened', workId, taskId, stage, gateId: gate.id, ts: Date.now() });

      const decision = await new Promise<GateDecision>((resolve) => {
        this.pendingGates.set(gate.id, resolve);
      });

      if (decision === 'rejected') {
        const failed: StageAttempt = {
          ...attempt,
          status: 'failed',
          finishedAt: this.now(),
          failureReason: 'Gate rejected',
        };
        this.stores.stages.save(failed);
        this.emit({ kind: 'stage_failed', workId, taskId, stage, attemptId: attempt.id, reason: 'Gate rejected', ts: Date.now() });
        return 'failed';
      }

      this.updateWorkOrTaskStatus(workId, taskId, 'running');
    }

    const completed: StageAttempt = {
      ...attempt,
      status: 'completed',
      finishedAt: this.now(),
    };
    this.stores.stages.save(completed);
    this.emit({ kind: 'stage_completed', workId, taskId, stage, attemptId: attempt.id, ts: Date.now() });
    return 'completed';
  }

  private updateWorkStatus(workId: string, status: Work['status']): void {
    const work = this.stores.work.getById(workId);
    if (!work) return;
    this.stores.work.save({ ...work, status, updatedAt: this.now() });
    this.emit({ kind: 'work_status_changed', workId, status, ts: Date.now() });
  }

  private updateTaskStatus(_workId: string, taskId: string, status: Task['status']): void {
    const task = this.stores.tasks.getById(taskId);
    if (!task) return;
    this.stores.tasks.save({ ...task, status, updatedAt: this.now() });
  }

  private updateWorkOrTaskStatus(workId: string, taskId: string | null, status: 'running' | 'gated'): void {
    if (taskId) {
      const task = this.stores.tasks.getById(taskId);
      if (task) this.stores.tasks.save({ ...task, status, updatedAt: this.now() });
    } else {
      this.updateWorkStatus(workId, status);
    }
  }

  private emit(event: DomainEvent): void {
    this.eventStore.append(event);
    this.eventBus.publish(event);
  }

  private newId(): string {
    return crypto.randomUUID();
  }

  private now(): string {
    return new Date().toISOString();
  }
}
