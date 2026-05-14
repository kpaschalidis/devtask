export interface ContextProvider {
  overview(repoPath: string): Promise<string>
  focused(repoPath: string, hints: string[]): Promise<string>
  diff(workspacePath: string): Promise<string>
}
