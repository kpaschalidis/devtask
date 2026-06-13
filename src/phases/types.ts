import type { AgentSessionRef } from "../agent-session.js";
import type { AgentStartOptions } from "../agent.js";
import type { DevtaskPaths } from "../infra/paths.js";
import type { PhaseRun } from "../infra/phase-run.js";

export interface PhaseResult {
  status: string;
  artifacts: Record<string, string>;
}

export interface PhaseScope {
  tmuxSession: string;
  cwd: string;
  promptPath: string;
  outputPath: string;
  taskId: string | null;
  artifacts: Record<string, string>;
}

export interface PhaseFreshScope {
  scope: PhaseScope;
  prompt: string;
  startOptions: AgentStartOptions;
}

export interface PhaseConfig {
  freshScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string): Promise<PhaseFreshScope>;
  resumeScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string): PhaseScope;
  workspacePath(paths: DevtaskPaths, workId: string, repoId: string | null): string;
  finalize(
    paths: DevtaskPaths,
    workId: string,
    repoId: string | null,
    sessionRecord: PhaseRun,
    session: AgentSessionRef,
    finishedAt: string
  ): Promise<PhaseResult>;
  attach(paths: DevtaskPaths, workId: string, repoId: string | null): Promise<void>;
  sendFeedback(paths: DevtaskPaths, workId: string, repoId: string | null, message: string): Promise<void>;
  reset(paths: DevtaskPaths, workId: string, repoId: string | null): void;
}
