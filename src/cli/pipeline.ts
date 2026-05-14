import crypto from 'node:crypto';
import path from 'node:path';
import { Command } from 'commander';
import { resolvePaths } from '../paths.js';
import { readConfig } from '../config.js';
import { createDevtaskPipeline } from '../bootstrap.js';
import { printError, printTable } from './support.js';
import type { Work } from '../core/domain/work.js';
import type { Task } from '../core/domain/task.js';
import type { ExecutionGraph } from '../core/domain/execution-graph.js';

function ts() { return new Date().toISOString(); }

export function registerPipelineCommands(program: Command): void {
  const p = program
    .command('pipeline')
    .alias('p')
    .description('Pipeline-based work management');

  // ── work create ────────────────────────────────────────────────────────────

  const pw = p.command('work').description('Manage pipeline work items');

  pw.command('create <title>')
    .description('Create a new work item')
    .option('-r, --repo <path>', 'Repository path (defaults to cwd)', process.cwd())
    .option('-d, --description <text>', 'Work description')
    .action((title: string, opts: { repo: string; description?: string }) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const { stores, close } = createDevtaskPipeline(paths, config);
        try {
          const workId = crypto.randomUUID();
          const now = ts();
          const work: Work = {
            id: workId,
            repoPaths: [path.resolve(opts.repo)],
            title,
            description: opts.description ?? null,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          };
          stores.work.save(work);
          console.log(workId);
        } finally {
          close();
        }
      } catch (err) {
        printError(err);
      }
    });

  // ── work task add ──────────────────────────────────────────────────────────

  pw.command('task add <workId> <title>')
    .description('Add a task to a work item (builds the execution graph)')
    .option('-r, --repo <path>', 'Repository path (defaults to work repo)')
    .option('-d, --description <text>', 'Task description')
    .option('-s, --script <bash>', 'Verify script')
    .option('--depends-on <ids...>', 'Task IDs this task depends on')
    .action((workId: string, title: string, opts: { repo?: string; description?: string; script?: string; dependsOn?: string[] }) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const { stores, close } = createDevtaskPipeline(paths, config);
        try {
          const work = stores.work.getById(workId);
          if (!work) { console.error(`Work not found: ${workId}`); process.exit(1); }

          const taskId = crypto.randomUUID();
          const now = ts();
          const task: Task = {
            id: taskId,
            workId,
            repoPath: opts.repo ? path.resolve(opts.repo) : (work.repoPaths[0] ?? process.cwd()),
            title,
            description: opts.description ?? null,
            status: 'pending',
            dependsOn: opts.dependsOn ?? [],
            acceptanceCriteria: [],
            filesToCreate: [],
            filesToModify: [],
            phase: 1,
            verifyScript: opts.script,
            createdAt: now,
            updatedAt: now,
          };
          stores.tasks.save(task);

          // Rebuild execution graph from all tasks for this work
          const allTasks = stores.tasks.listByWork(workId);
          const graph: ExecutionGraph = {
            id: crypto.randomUUID(),
            workId,
            tasks: allTasks,
            createdAt: now,
            approvedAt: null,
          };
          stores.graph.save(graph);

          console.log(taskId);
        } finally {
          close();
        }
      } catch (err) {
        printError(err);
      }
    });

  // ── work start ─────────────────────────────────────────────────────────────

  pw.command('start <workId>')
    .description('Start a work item and wait for completion')
    .action(async (workId: string) => {
      const paths = resolvePaths();
      const config = readConfig(paths);
      const { pipeline, stores, close } = createDevtaskPipeline(paths, config);

      const onExit = () => { close(); process.exit(0); };
      process.on('SIGINT', onExit);
      process.on('SIGTERM', onExit);

      try {
        await pipeline.startWork(workId);
        console.log(`Started ${workId} — waiting for completion...`);

        await pollUntil(() => {
          const w = stores.work.getById(workId);
          return w?.status === 'completed' || w?.status === 'failed';
        }, 2_000, () => {
          const w = stores.work.getById(workId);
          const tasks = stores.tasks.listByWork(workId);
          const counts = { pending: 0, running: 0, gated: 0, completed: 0, failed: 0 };
          for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
          process.stdout.write(`\r[${w?.status ?? '?'}] tasks: ${JSON.stringify(counts)}   `);
        });

        process.stdout.write('\n');
        const final = stores.work.getById(workId);
        console.log(`\nWork ${workId}: ${final?.status}`);
        if (final?.status === 'failed') process.exitCode = 1;
      } catch (err) {
        printError(err);
      } finally {
        close();
      }
    });

  // ── work status ────────────────────────────────────────────────────────────

  pw.command('status <workId>')
    .description('Show work item and task statuses')
    .action((workId: string) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const { stores, close } = createDevtaskPipeline(paths, config);
        try {
          const work = stores.work.getById(workId);
          if (!work) { console.error(`Work not found: ${workId}`); process.exit(1); }

          console.log(`\nWork:   ${work.id}`);
          console.log(`Title:  ${work.title}`);
          console.log(`Status: ${work.status}`);
          console.log(`Repos:  ${work.repoPaths.join(', ')}`);

          const tasks = stores.tasks.listByWork(workId);
          if (tasks.length > 0) {
            console.log('');
            printTable(
              ['ID', 'STATUS', 'TITLE'],
              tasks.map((t) => [t.id.slice(0, 8), t.status, t.title]),
            );
          }
        } finally {
          close();
        }
      } catch (err) {
        printError(err);
      }
    });

  // ── work approve ───────────────────────────────────────────────────────────

  pw.command('approve <taskId>')
    .description('Approve the ship review gate for a task')
    .action(async (taskId: string) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const { pipeline, close } = createDevtaskPipeline(paths, config);
        try {
          await pipeline.resumeTask(taskId, 'ship', { approved: true });
          console.log(`Approved ${taskId}`);
        } finally {
          close();
        }
      } catch (err) {
        printError(err);
      }
    });

  // ── work reject ────────────────────────────────────────────────────────────

  pw.command('reject <taskId>')
    .description('Reject the ship review gate for a task')
    .action(async (taskId: string) => {
      try {
        const paths = resolvePaths();
        const config = readConfig(paths);
        const { pipeline, close } = createDevtaskPipeline(paths, config);
        try {
          await pipeline.resumeTask(taskId, 'ship', { approved: false });
          console.log(`Rejected ${taskId}`);
        } finally {
          close();
        }
      } catch (err) {
        printError(err);
      }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil(
  condition: () => boolean,
  intervalMs: number,
  onTick?: () => void,
): Promise<void> {
  while (!condition()) {
    onTick?.();
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
