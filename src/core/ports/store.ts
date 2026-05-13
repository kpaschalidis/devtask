import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { StageAttempt } from '../domain/stage-attempt.js';
import type { RunAttempt } from '../domain/run-attempt.js';
import type { Artifact } from '../domain/artifact.js';
import type { Gate } from '../domain/gate.js';
import type { AgentQuestion } from '../domain/agent-question.js';

export interface WorkStore {
  save(work: Work): void;
  getById(id: string): Work | null;
  listActive(): Work[];
}

export interface TaskStore {
  save(task: Task): void;
  getById(id: string): Task | null;
  listByWork(workId: string): Task[];
}

export interface ExecutionGraphStore {
  save(graph: ExecutionGraph): void;
  getByWork(workId: string): ExecutionGraph | null;
}

export interface StageAttemptStore {
  save(attempt: StageAttempt): void;
  getById(id: string): StageAttempt | null;
  listByTask(workId: string, taskId: string): StageAttempt[];
  listByWork(workId: string): StageAttempt[];
  latestForStage(workId: string, taskId: string | null, stage: string): StageAttempt | null;
}

export interface RunAttemptStore {
  save(attempt: RunAttempt): void;
  getById(id: string): RunAttempt | null;
  getByStageAttempt(stageAttemptId: string): RunAttempt | null;
}

export interface ArtifactStore {
  save(artifact: Artifact): void;
  listByStageAttempt(stageAttemptId: string): Artifact[];
  listByTask(workId: string, taskId: string): Artifact[];
}

export interface GateStore {
  save(gate: Gate): void;
  getOpenGate(workId: string, taskId: string | null, stage: string): Gate | null;
}

export interface AgentQuestionStore {
  save(question: AgentQuestion): void;
  getOpenQuestion(runAttemptId: string): AgentQuestion | null;
}
