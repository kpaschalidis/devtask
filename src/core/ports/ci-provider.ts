export type CiState = 'pending' | 'running' | 'passed' | 'failed' | 'unknown';

export interface CiStatus {
  state: CiState;
  url: string | null;
  summary: string | null;
}

export interface CiProvider {
  getStatus(branch: string, commitSha?: string): Promise<CiStatus>;
}
