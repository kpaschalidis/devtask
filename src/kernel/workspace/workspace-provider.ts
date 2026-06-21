export interface WorkspaceHandle {
  path: string;
  branch: string | null;
  repoPath: string;
}

export interface ScriptResult {
  exitCode: number;
  output: string;
}

export interface WorkspaceCreateRequest {
  repoPath: string;
  targetPath: string;
  branchName?: string | null;
  workspaceName?: string | null;
}

export interface WorkspaceDriver {
  createWorkspace(input: WorkspaceCreateRequest): Promise<WorkspaceHandle>;
  removeWorkspace(workspace: WorkspaceHandle): Promise<void>;
  runScript(workspace: WorkspaceHandle, script: string): Promise<ScriptResult>;
}
