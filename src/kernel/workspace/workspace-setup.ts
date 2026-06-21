import type { SessionLabels, SessionOwner } from '../trace/session-history.js';

export interface WorkspaceSetupInput {
  workspacePath: string;
  agentName: string;
  owner?: SessionOwner;
  labels?: SessionLabels;
}

export interface WorkspaceSetupResult {
  env: Record<string, string>;
  pathEntries: string[];
}

export interface WorkspaceSetup {
  prepare(input: WorkspaceSetupInput): Promise<WorkspaceSetupResult>;
}

export class NoopWorkspaceSetup implements WorkspaceSetup {
  async prepare(): Promise<WorkspaceSetupResult> {
    return { env: {}, pathEntries: [] };
  }
}
