import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskPhase, TaskPhaseContext, PhaseOutcome } from '../core/pipeline/phase.js';

const execFileAsync = promisify(execFile);

async function currentBranch(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: workspacePath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function extractApproved(resumeData: unknown): boolean {
  if (typeof resumeData === 'object' && resumeData !== null && 'approved' in resumeData) {
    return Boolean((resumeData as { approved: unknown }).approved);
  }
  return false;
}

export const shipPhase: TaskPhase = {
  id: 'ship',

  async execute(ctx: TaskPhaseContext): Promise<PhaseOutcome> {
    const { taskId, workspacePath, stores, ports, resumeData, suspend, logger } = ctx;
    const { publishProvider } = ports;

    const task = stores.tasks.getById(taskId);
    if (!task) return 'failed';

    if (resumeData !== null) {
      // Resuming after review gate
      if (!extractApproved(resumeData)) return 'rejected';

      if (!publishProvider) {
        logger.info({ taskId }, 'No publish provider configured; skipping PR creation');
        return 'completed';
      }

      const branch = await currentBranch(workspacePath);
      if (!branch) {
        logger.error({ taskId }, 'Could not determine branch name for PR');
        return 'failed';
      }

      try {
        const pr = await publishProvider.createPr({
          branch,
          base: 'main',
          title: task.title,
          body: task.description ?? '',
          draft: false,
          labels: [],
        });
        logger.info({ taskId, prUrl: pr.url }, 'PR created');
      } catch (err) {
        logger.error({ taskId, err }, 'Failed to create PR');
        return 'failed';
      }

      return 'completed';
    }

    // First call — suspend for human review gate
    const branch = await currentBranch(workspacePath);
    await suspend({ taskId, branch, workspacePath, message: 'Review changes before creating PR' });
    return 'completed'; // unreachable
  },
};
