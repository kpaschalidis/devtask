import type { Task } from './task.js';

export interface ExecutionGraph {
  id: string;
  workId: string;
  tasks: Task[];
  createdAt: string;
  approvedAt: string | null;
}
