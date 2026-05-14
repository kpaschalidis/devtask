import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';

export interface WorkStore {
  save(work: Work): void;
  getById(id: string): Work | null;
  listActive(): Work[];
}

export interface TaskStore {
  save(task: Task): void;
  getById(id: string): Task | null;
  listByWork(workId: string): Task[];
}

export interface ExecutionGraphStore {
  save(graph: ExecutionGraph): void;
  getByWork(workId: string): ExecutionGraph | null;
}

export interface CoreStores {
  work: WorkStore;
  tasks: TaskStore;
  graph: ExecutionGraphStore;
}
