import type { AgentStartOptions } from "../agent.js";
import type { DevtaskPaths } from "../infra/paths.js";
import type { SessionRun } from "../infra/session-run.js";

export interface RoleResult {
  status: string;
  artifacts: Record<string, string>;
}

export interface RoleScope {
  tmuxSession: string;
  cwd: string;
  promptPath: string;
  outputPath: string;
  taskId: string | null;
  artifacts: Record<string, string>;
}

export interface RoleFreshScope {
  scope: RoleScope;
  prompt: string;
  startOptions: AgentStartOptions;
}

export interface RoleLaunchResult {
  phase: string;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: "started" | "running";
  tmuxSession: string;
  promptPath: string;
  outputPath: string;
}

export interface FreshScopeOpts {
  acceptRecommended?: boolean;
}

export interface RoleConfig {
  freshScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string, opts?: FreshScopeOpts): Promise<RoleFreshScope>;
  resumeScope(paths: DevtaskPaths, workId: string, repoId: string | null, runId: string): RoleScope;
  workspacePath(paths: DevtaskPaths, workId: string, repoId: string | null): string;
  finalize(paths: DevtaskPaths, workId: string, repoId: string | null, sessionRecord: SessionRun): Promise<RoleResult>;
  attach(paths: DevtaskPaths, workId: string, repoId: string | null): Promise<void>;
  sendFeedback(paths: DevtaskPaths, workId: string, repoId: string | null, message: string): Promise<RoleLaunchResult>;
  reset(paths: DevtaskPaths, workId: string, repoId: string | null): void;
}
