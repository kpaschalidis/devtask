import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { StageAttempt } from '../domain/stage-attempt.js';
import type { Artifact } from '../domain/artifact.js';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RuntimeBackend } from '../ports/runtime-backend.js';
import type { PublishProvider } from '../ports/publish-provider.js';
import type { CiProvider } from '../ports/ci-provider.js';
import type { ContextProvider } from '../ports/context-provider.js';

export interface StageContext {
  work: Work;
  task: Task | null;           // null for Work-level phases
  attempt: StageAttempt;
  artifacts: Artifact[];       // artifacts produced by prior stages for this task
  ports: {
    agentRunner: AgentRunner;
    runtimeBackend: RuntimeBackend;
    publishProvider: PublishProvider | null;
    ciProvider: CiProvider | null;
    contextProvider: ContextProvider;
  };
}

export type StageResult =
  | { outcome: 'completed'; artifacts: Artifact[] }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'needs_input'; question: string };

export interface StageHandler {
  execute(ctx: StageContext): Promise<StageResult>;
}
