import crypto from 'node:crypto';
import type { WorkPhase, WorkPhaseContext, PhaseOutcome } from '../core/pipeline/phase.js';
import type { Spec, QAEntry } from '../core/domain/spec.js';

const DONE_MARKER = '<<<SPEC_COMPLETE>>>';

function buildInitialPrompt(title: string, description: string | null, repoOverview: string): string {
  return [
    '# Spec Refinement Session',
    '',
    'You are helping refine a development work item into a precise, locked spec.',
    '',
    '## Work Item',
    `**Title:** ${title}`,
    description ? `**Description:** ${description}` : '',
    '',
    repoOverview ? `## Repo Context\n${repoOverview}\n` : '',
    '## Instructions',
    'Ask targeted clarifying questions to fully understand the scope, edge cases, and acceptance criteria.',
    'When you have enough information to write a complete spec, output the spec in markdown followed by:',
    DONE_MARKER,
    '',
    'Start by asking your first round of questions.',
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
    'Continue refining or output the final spec followed by ' + DONE_MARKER,
  ].join('\n');
}

function extractSpec(output: string): string | null {
  const idx = output.indexOf(DONE_MARKER);
  if (idx === -1) return null;
  return output.slice(0, idx).trim();
}

function now() { return new Date().toISOString(); }

export const refinePhase: WorkPhase = {
  id: 'refine',

  async execute(ctx: WorkPhaseContext): Promise<PhaseOutcome> {
    const { workId, stores, ports, resumeData, suspend, logger } = ctx;
    const { agentRunner, contextProvider } = ports;

    const work = stores.work.getById(workId);
    if (!work) return 'failed';

    stores.work.save({ ...work, status: 'refining', updatedAt: now() });

    let spec = stores.specs.getByWork(workId);
    if (!spec) {
      spec = {
        id: crypto.randomUUID(),
        workId,
        content: '',
        affectedRepoPaths: work.repoPaths,
        qaHistory: [],
        status: 'draft',
        createdAt: now(),
        updatedAt: now(),
      };
      stores.specs.save(spec);
    }

    let prompt: string;

    if (resumeData !== null) {
      const { answer } = resumeData as { answer: string };
      const questions = work.pendingQuestions ?? '';
      const entry: QAEntry = { questions: [questions], answers: { response: answer } };
      spec = { ...spec, qaHistory: [...spec.qaHistory, entry], updatedAt: now() };
      stores.specs.save(spec);
      stores.work.save({ ...work, pendingQuestions: undefined, updatedAt: now() });
      prompt = buildResumePrompt(questions, answer);
    } else {
      const repoOverview = contextProvider
        ? await contextProvider.overview(work.repoPaths[0] ?? '')
        : '';
      prompt = buildInitialPrompt(work.title, work.description, repoOverview);
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
            const specContent = extractSpec(fullOutput);
            if (specContent) {
              const locked: Spec = { ...spec, content: specContent, status: 'locked', updatedAt: now() };
              stores.specs.save(locked);
              stores.work.save({ ...stores.work.getById(workId)!, specId: locked.id, updatedAt: now() });
              logger.info({ workId }, 'Spec locked');
              return 'completed';
            }
            stores.work.save({ ...stores.work.getById(workId)!, pendingQuestions: fullOutput, updatedAt: now() });
            await suspend({ questions: fullOutput });
            return 'completed';
          }
          case 'input_required':
            stores.work.save({ ...stores.work.getById(workId)!, pendingQuestions: event.prompt, updatedAt: now() });
            await suspend({ questions: event.prompt });
            return 'completed';
          case 'failed':
            logger.error({ workId, error: event.error }, 'Refine agent failed');
            return 'failed';
          case 'stalled':
            logger.warn({ workId }, 'Refine agent stalled');
            return 'failed';
        }
      }
    } finally {
      await agentRunner.stop(session);
    }

    return 'completed';
  },
};
