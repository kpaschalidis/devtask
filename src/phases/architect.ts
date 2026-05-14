import crypto from 'node:crypto';
import type { WorkPhase, WorkPhaseContext, PhaseOutcome } from '../core/pipeline/phase.js';
import type { Task } from '../core/domain/task.js';
import type { ExecutionGraph } from '../core/domain/execution-graph.js';

const DONE_MARKER = '<<<PLAN_COMPLETE>>>';

function buildInitialPrompt(
  workId: string,
  specContent: string,
  repoPaths: string[],
  repoOverview: string,
): string {
  return [
    '# Architecture Planning Session',
    '',
    'You are breaking down a locked spec into a concrete execution plan (a set of tasks).',
    '',
    '## Spec',
    specContent,
    '',
    repoPaths.length > 1 ? `## Repositories\n${repoPaths.map(p => `- ${p}`).join('\n')}\n` : `## Repository\n${repoPaths[0] ?? 'unknown'}\n`,
    repoOverview ? `## Repo Context\n${repoOverview}\n` : '',
    '## Instructions',
    'Ask clarifying questions if needed. When ready, output a JSON execution plan followed by ' + DONE_MARKER,
    '',
    'The JSON must match this schema exactly:',
    '```json',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "<short-slug>",',
    '      "repoPath": "<one of the repo paths above>",',
    '      "title": "<concise title>",',
    '      "description": "<what to implement>",',
    '      "dependsOn": ["<sibling task id>"],',
    '      "acceptanceCriteria": ["<criterion>"],',
    '      "filesToCreate": ["<path>"],',
    '      "filesToModify": ["<path>"],',
    '      "phase": 1',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `workId for context: ${workId}`,
    '',
    'Start by asking any clarifying questions, or output the plan directly if the spec is clear.',
  ].filter(Boolean).join('\n');
}

function buildResumePrompt(questions: string, answer: string): string {
  return [
    '## Your Questions',
    questions,
    '',
    '## User Response',
    answer,
    '',
    'Continue planning or output the final JSON plan followed by ' + DONE_MARKER,
  ].join('\n');
}

function extractPlan(output: string): { tasks: Partial<Task>[] } | null {
  const idx = output.indexOf(DONE_MARKER);
  if (idx === -1) return null;
  const before = output.slice(0, idx);
  const jsonMatch = before.match(/```json\s*([\s\S]*?)\s*```/);
  const raw = jsonMatch?.[1] ?? before.trim();
  try {
    return JSON.parse(raw) as { tasks: Partial<Task>[] };
  } catch {
    return null;
  }
}

function now() { return new Date().toISOString(); }

export const architectPhase: WorkPhase = {
  id: 'architect',

  async execute(ctx: WorkPhaseContext): Promise<PhaseOutcome> {
    const { workId, stores, ports, resumeData, suspend, logger } = ctx;
    const { agentRunner, contextProvider } = ports;

    const work = stores.work.getById(workId);
    if (!work) return 'failed';

    stores.work.save({ ...work, status: 'architecting', updatedAt: now() });

    const spec = stores.specs.getByWork(workId);
    if (!spec || spec.status !== 'locked') {
      logger.error({ workId }, 'Architect: no locked spec found');
      return 'failed';
    }

    let prompt: string;

    if (resumeData !== null) {
      const { answer } = resumeData as { answer: string };
      const questions = work.pendingQuestions ?? '';
      stores.work.save({ ...work, pendingQuestions: undefined, updatedAt: now() });
      prompt = buildResumePrompt(questions, answer);
    } else {
      const repoOverview = contextProvider
        ? await contextProvider.overview(work.repoPaths[0] ?? '')
        : '';
      prompt = buildInitialPrompt(workId, spec.content, work.repoPaths, repoOverview);
    }

    const session = await agentRunner.start(work.repoPaths[0] ?? process.cwd());
    let fullOutput = '';

    try {
      for await (const event of agentRunner.run(session, prompt)) {
        switch (event.kind) {
          case 'output':
            fullOutput += event.text;
            break;
          case 'completed': {
            const plan = extractPlan(fullOutput);
            if (plan) {
              const tasks: Task[] = plan.tasks.map((t, i) => ({
                id: t.id ?? crypto.randomUUID(),
                workId,
                repoPath: t.repoPath ?? work.repoPaths[0] ?? '',
                title: t.title ?? `Task ${i + 1}`,
                description: t.description ?? null,
                status: 'pending' as const,
                dependsOn: t.dependsOn ?? [],
                acceptanceCriteria: t.acceptanceCriteria ?? [],
                filesToCreate: t.filesToCreate ?? [],
                filesToModify: t.filesToModify ?? [],
                phase: t.phase ?? 1,
                createdAt: now(),
                updatedAt: now(),
              }));

              for (const task of tasks) stores.tasks.save(task);

              const graph: ExecutionGraph = {
                id: crypto.randomUUID(),
                workId,
                tasks,
                createdAt: now(),
                approvedAt: null,
              };
              stores.graph.save(graph);

              logger.info({ workId, taskCount: tasks.length }, 'Execution graph created');
              return 'completed';
            }
            // No plan yet — agent has questions
            stores.work.save({ ...stores.work.getById(workId)!, pendingQuestions: fullOutput, updatedAt: now() });
            await suspend({ questions: fullOutput });
            return 'completed';
          }
          case 'input_required':
            stores.work.save({ ...stores.work.getById(workId)!, pendingQuestions: event.prompt, updatedAt: now() });
            await suspend({ questions: event.prompt });
            return 'completed';
          case 'failed':
            logger.error({ workId, error: event.error }, 'Architect agent failed');
            return 'failed';
          case 'stalled':
            logger.warn({ workId }, 'Architect agent stalled');
            return 'failed';
        }
      }
    } finally {
      await agentRunner.stop(session);
    }

    return 'completed';
  },
};
