export interface WorkspaceInfo {
  path: string;
  workId: string;
  taskId: string;
  branch: string | null;
  repoPath: string;
}

export interface ScriptResult {
  exitCode: number;
  output: string;
}

export interface RuntimeBackend {
  createWorkspace(workId: string, taskId: string, repoPath: string): Promise<WorkspaceInfo>;
  removeWorkspace(workspace: WorkspaceInfo): Promise<void>;
  runScript(workspace: WorkspaceInfo, script: string): Promise<ScriptResult>;
}
