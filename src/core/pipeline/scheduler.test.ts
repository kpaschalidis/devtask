import { describe, it, expect } from 'vitest';
import { getReadyTasks, isExecComplete, hasFailedTask } from './scheduler.js';
import type { ExecutionGraph } from '../domain/execution-graph.js';
import type { Task } from '../domain/task.js';

function makeTask(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    workId: 'w-1',
    repoPath: '/repo/a',
    title: partial.id,
    description: null,
    status: 'pending',
    dependsOn: [],
    acceptanceCriteria: [],
    filesToCreate: [],
    filesToModify: [],
    phase: 1,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

function makeGraph(tasks: Task[]): ExecutionGraph {
  return { id: 'g-1', workId: 'w-1', tasks, createdAt: '', approvedAt: null };
}

describe('getReadyTasks', () => {
  it('returns all tasks with no dependencies when none are running', () => {
    const graph = makeGraph([makeTask({ id: 't-1' }), makeTask({ id: 't-2' })]);
    const ready = getReadyTasks(graph, new Map());
    expect(ready.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it('excludes tasks whose dependencies are not completed', () => {
    const graph = makeGraph([
      makeTask({ id: 't-1' }),
      makeTask({ id: 't-2', dependsOn: ['t-1'] }),
    ]);
    const ready = getReadyTasks(graph, new Map([['t-1', 'running']]));
    expect(ready.map((t) => t.id)).toEqual([]);
  });

  it('includes a task once its dependency completes', () => {
    const graph = makeGraph([
      makeTask({ id: 't-1' }),
      makeTask({ id: 't-2', dependsOn: ['t-1'] }),
    ]);
    const ready = getReadyTasks(graph, new Map([['t-1', 'completed']]));
    expect(ready.map((t) => t.id)).toEqual(['t-2']);
  });

  it('blocks tasks on the same repo if one is already running', () => {
    const graph = makeGraph([
      makeTask({ id: 't-1', repoPath: '/repo/a' }),
      makeTask({ id: 't-2', repoPath: '/repo/a' }),
    ]);
    const ready = getReadyTasks(graph, new Map([['t-1', 'running']]));
    expect(ready).toHaveLength(0);
  });

  it('allows tasks on different repos to run in parallel', () => {
    const graph = makeGraph([
      makeTask({ id: 't-1', repoPath: '/repo/a' }),
      makeTask({ id: 't-2', repoPath: '/repo/b' }),
    ]);
    const ready = getReadyTasks(graph, new Map([['t-1', 'running']]));
    expect(ready.map((t) => t.id)).toEqual(['t-2']);
  });

  it('excludes tasks that are already running or completed', () => {
    const graph = makeGraph([
      makeTask({ id: 't-1', repoPath: '/repo/a' }),
      makeTask({ id: 't-2', repoPath: '/repo/b' }),
    ]);
    const states = new Map([['t-1', 'running' as const], ['t-2', 'completed' as const]]);
    expect(getReadyTasks(graph, states)).toHaveLength(0);
  });
});

describe('isExecComplete', () => {
  it('returns true when all tasks are terminal', () => {
    const graph = makeGraph([makeTask({ id: 't-1' }), makeTask({ id: 't-2' })]);
    const states = new Map([['t-1', 'completed' as const], ['t-2', 'failed' as const]]);
    expect(isExecComplete(graph, states)).toBe(true);
  });

  it('returns false when any task is still pending', () => {
    const graph = makeGraph([makeTask({ id: 't-1' }), makeTask({ id: 't-2' })]);
    expect(isExecComplete(graph, new Map([['t-1', 'completed' as const]]))).toBe(false);
  });
});

describe('hasFailedTask', () => {
  it('returns true when any task failed', () => {
    const graph = makeGraph([makeTask({ id: 't-1' }), makeTask({ id: 't-2' })]);
    const states = new Map([['t-1', 'completed' as const], ['t-2', 'failed' as const]]);
    expect(hasFailedTask(graph, states)).toBe(true);
  });

  it('returns false when no tasks failed', () => {
    const graph = makeGraph([makeTask({ id: 't-1' })]);
    expect(hasFailedTask(graph, new Map([['t-1', 'completed' as const]]))).toBe(false);
  });
});
