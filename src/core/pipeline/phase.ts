import type { SessionHandle } from '../domain/task.js';
import type { CoreStores } from '../ports/store.js';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RuntimeBackend } from '../ports/runtime-backend.js';
import type { PublishProvider } from '../ports/publish-provider.js';
import type { CiProvider } from '../ports/ci-provider.js';
import type { ContextProvider } from '../ports/context-provider.js';
import type { Logger } from '../logging/index.js';

// ---------------------------------------------------------------------------
// Ports available to every phase
// ---------------------------------------------------------------------------

export interface PipelinePorts {
  agentRunner: AgentRunner;
  runtimeBackend: RuntimeBackend;
  publishProvider: PublishProvider | null;
  ciProvider: CiProvider | null;
  contextProvider: ContextProvider | null;
}

// ---------------------------------------------------------------------------
// Phase outcome
// ---------------------------------------------------------------------------

export type PhaseOutcome = 'completed' | 'failed' | 'rejected';

// ---------------------------------------------------------------------------
// WorkPhase — runs once per work item, sequentially before task execution
// ---------------------------------------------------------------------------

export interface WorkPhaseContext {
  workId: string;
  stores: CoreStores;
  ports: PipelinePorts;
  resumeData: unknown | null;
  suspend(payload: unknown): Promise<void>;
  logger: Logger;
}

export interface WorkPhase {
  readonly id: string;
  execute(ctx: WorkPhaseContext): Promise<PhaseOutcome>;
}

// ---------------------------------------------------------------------------
// TaskPhase — runs per task inside the fixed task pipeline structure
// ---------------------------------------------------------------------------

export interface TaskPhaseContext {
  workId: string;
  taskId: string;
  workspacePath: string;
  sessionHandle?: SessionHandle;
  verifyOutput?: string;   // populated when called in fix mode
  stores: CoreStores;
  ports: PipelinePorts;
  resumeData: unknown | null;
  suspend(payload: unknown): Promise<void>;
  logger: Logger;
}

export interface VerifyResult {
  passed: boolean;
  output: string;
}

export interface TaskPhase {
  readonly id: string;
  execute(ctx: TaskPhaseContext): Promise<PhaseOutcome>;
}

export interface VerifyPhase {
  readonly id: string;
  execute(ctx: TaskPhaseContext): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Pipeline config
// ---------------------------------------------------------------------------

export interface TaskPhasesConfig {
  implement: TaskPhase;
  verify: VerifyPhase;
  ship: TaskPhase;
}

export interface PipelineConfig {
  workPhases: WorkPhase[];
  taskPhases: TaskPhasesConfig;
  ports: PipelinePorts;
  stores: CoreStores;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Pipeline public API
// ---------------------------------------------------------------------------

export interface Pipeline {
  startWork(workId: string): Promise<void>;
  resumeWork(workId: string, phaseId: string, resumeData: unknown): Promise<void>;
  resumeTask(taskId: string, phaseId: string, resumeData: unknown): Promise<void>;
}
