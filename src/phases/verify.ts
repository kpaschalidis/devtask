import type { VerifyPhase, TaskPhaseContext, VerifyResult } from '../core/pipeline/phase.js';
import type { WorkspaceInfo } from '../core/ports/runtime-backend.js';

export const verifyPhase: VerifyPhase = {
  id: 'verify',

  async execute(ctx: TaskPhaseContext): Promise<VerifyResult> {
    const { taskId, workspacePath, stores, ports, logger } = ctx;
    const { runtimeBackend } = ports;

    const task = stores.tasks.getById(taskId);
    if (!task?.verifyScript) {
      logger.info({ taskId }, 'No verify script; treating as passed');
      return { passed: true, output: '' };
    }

    const workspace: WorkspaceInfo = {
      path: workspacePath,
      workId: task.workId,
      taskId,
      branch: null,
      repoPath: task.repoPath,
    };

    const result = await runtimeBackend.runScript(workspace, task.verifyScript);
    const passed = result.exitCode === 0;

    logger.info({ taskId, passed, exitCode: result.exitCode }, 'Verify script result');
    return { passed, output: result.output };
  },
};
