import type { Work } from '../domain/work.js';
import type { Task } from '../domain/task.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { Spec } from '../domain/spec.js';

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

export interface SpecStore {
  save(spec: Spec): void;
  getById(id: string): Spec | null;
  getByWork(workId: string): Spec | null;
}

export interface CoreStores {
  work: WorkStore;
  tasks: TaskStore;
  graph: ExecutionGraphStore;
  specs: SpecStore;
}
