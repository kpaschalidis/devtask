import type { TaskPhase, TaskPhaseContext, PhaseOutcome } from '../core/pipeline/phase.js';
import type { Task } from '../core/domain/task.js';

function buildPrompt(task: Task, verifyOutput?: string): string {
  if (verifyOutput) {
    return [
      '# Fix Required',
      '',
      'Verification failed. Output:',
      '```',
      verifyOutput,
      '```',
      '',
      'Fix the issues and ensure the verify script passes.',
    ].join('\n');
  }

  const lines = [`# Task: ${task.title}`];
  if (task.description) lines.push('', task.description);
  if (task.verifyScript) {
    lines.push(
      '',
      '## Verify Script',
      '```bash',
      task.verifyScript,
      '```',
      'Implement the task such that this verify script exits 0.',
    );
  }
  return lines.join('\n');
}

function extractAnswer(resumeData: unknown): string {
  if (typeof resumeData === 'object' && resumeData !== null && 'answer' in resumeData) {
    return String((resumeData as { answer: unknown }).answer);
  }
  return String(resumeData);
}

function now() { return new Date().toISOString(); }

export const implementPhase: TaskPhase = {
  id: 'implement',

  async execute(ctx: TaskPhaseContext): Promise<PhaseOutcome> {
    const { taskId, workspacePath, sessionHandle: existingSession, stores, ports, resumeData, suspend, logger } = ctx;
    const { agentRunner } = ports;

    const task = stores.tasks.getById(taskId);
    if (!task) return 'failed';

    let session = existingSession;
    let prompt: string;

    if (resumeData !== null) {
      // Resume after suspension — human answered the agent's question
      if (!session) {
        logger.error({ taskId }, 'Resumed implement phase with no session handle');
        return 'failed';
      }
      prompt = extractAnswer(resumeData);
    } else if (session) {
      // Fix mode — session already exists, send fix prompt with verify failure output
      prompt = buildPrompt(task, ctx.verifyOutput);
    } else {
      // First call — start agent session
      session = await agentRunner.start(workspacePath);
      stores.tasks.save({ ...task, sessionHandle: session, updatedAt: now() });
      prompt = buildPrompt(task);
    }

    for await (const event of agentRunner.run(session, prompt)) {
      switch (event.kind) {
        case 'completed':
          return 'completed';

        case 'failed':
          logger.error({ taskId, error: event.error }, 'Agent failed');
          return 'failed';

        case 'stalled':
          logger.warn({ taskId }, 'Agent stalled during implementation');
          return 'failed';

        case 'input_required': {
          const latest = stores.tasks.getById(taskId);
          if (latest) stores.tasks.save({ ...latest, sessionHandle: session, updatedAt: now() });
          await suspend({ question: event.prompt });
          return 'completed'; // unreachable — Mastra suspends execution here
        }

        case 'output':
          logger.info({ taskId, len: event.text.length }, 'Agent output');
          break;
      }
    }

    return 'completed';
  },
};
