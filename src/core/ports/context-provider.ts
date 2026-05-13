import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { Artifact } from '../domain/artifact.js';

export interface ContextProvider {
  buildContext(work: Work, task: Task | null, stage: string, artifacts: Artifact[]): Promise<string>;
}
