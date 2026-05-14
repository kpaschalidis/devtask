import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { Task, TaskStatus } from '../domain/task.js';

export function getReadyTasks(
  graph: ExecutionGraph,
  taskStates: Map<string, TaskStatus>,
): Task[] {
  const runningRepos = new Set(
    graph.tasks
      .filter((t) => taskStates.get(t.id) === 'running')
      .map((t) => t.repoPath),
  );

  return graph.tasks.filter((task) => {
    const status = taskStates.get(task.id) ?? 'pending';
    if (status !== 'pending') return false;
    if (runningRepos.has(task.repoPath)) return false;
    return task.dependsOn.every((depId) => taskStates.get(depId) === 'completed');
  });
}

export function isExecComplete(
  graph: ExecutionGraph,
  taskStates: Map<string, TaskStatus>,
): boolean {
  return graph.tasks.every((t) => {
    const status = taskStates.get(t.id) ?? 'pending';
    return status === 'completed' || status === 'failed';
  });
}

export function hasFailedTask(
  graph: ExecutionGraph,
  taskStates: Map<string, TaskStatus>,
): boolean {
  return graph.tasks.some((t) => taskStates.get(t.id) === 'failed');
}
