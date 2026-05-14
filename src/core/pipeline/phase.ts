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
// Gate factory — a WorkPhase that suspends for human approval
// ---------------------------------------------------------------------------

function now() { return new Date().toISOString(); }

export function createGate(
  id: string,
  getArtifact: (ctx: WorkPhaseContext) => unknown,
): WorkPhase {
  return {
    id,
    async execute(ctx: WorkPhaseContext): Promise<PhaseOutcome> {
      const { workId, stores, resumeData, suspend } = ctx;

      if (resumeData !== null) {
        const { approved } = resumeData as { approved: boolean };
        const work = stores.work.getById(workId);
        if (work) stores.work.save({ ...work, gateId: undefined, updatedAt: now() });
        return approved ? 'completed' : 'rejected';
      }

      const work = stores.work.getById(workId);
      if (work) stores.work.save({ ...work, status: 'gated', gateId: id, updatedAt: now() });
      await suspend({ artifact: getArtifact(ctx) });
      return 'completed';
    },
  };
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
  storageDir?: string;  // if set, Mastra workflow state persists to disk
}

// ---------------------------------------------------------------------------
// Pipeline public API
// ---------------------------------------------------------------------------

export interface Pipeline {
  startWork(workId: string): Promise<void>;
  resumeWork(workId: string, phaseId: string, resumeData: unknown): Promise<void>;
  resumeTask(taskId: string, phaseId: string, resumeData: unknown): Promise<void>;
  messageTask(taskId: string, message: string): Promise<void>;
}
