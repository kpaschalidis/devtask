import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeBackend, WorkspaceInfo, ScriptResult } from '../core/ports/runtime-backend.js';
import { createTaskWorktree } from '../git.js';

const execFileAsync = promisify(execFile);

export interface LocalRuntimeConfig {
  // Root directory where git worktrees are created.
  // Each workspace lives at <workspacesRoot>/<workId>/<taskId>/
  workspacesRoot: string;
}

export class LocalRuntimeBackend implements RuntimeBackend {
  constructor(private readonly config: LocalRuntimeConfig) {}

  async createWorkspace(workId: string, taskId: string, repoPath: string): Promise<WorkspaceInfo> {
    const worktreeDir = path.join(this.config.workspacesRoot, workId, taskId);
    const branch = `devtask/${workId.slice(0, 8)}-${taskId.slice(0, 8)}`;

    // Uses the battle-tested v1 implementation (idempotent, excludes devtask runtime files)
    await createTaskWorktree(repoPath, branch, worktreeDir);

    return {
      path: worktreeDir,
      workId,
      taskId,
      branch: await currentBranch(worktreeDir),
      repoPath,
    };
  }

  async removeWorkspace(workspace: WorkspaceInfo): Promise<void> {
    if (!fs.existsSync(workspace.path)) return;

    await execFileAsync('git', ['worktree', 'remove', '--force', workspace.path], {
      cwd: workspace.repoPath,
    }).catch(() => {});

    fs.rmSync(workspace.path, { recursive: true, force: true });
  }

  async runScript(workspace: WorkspaceInfo, script: string): Promise<ScriptResult> {
    const scriptPath = path.join(
      workspace.path,
      `.devtask-script-${crypto.randomUUID()}.sh`,
    );

    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, {
      mode: 0o700,
    });

    try {
      const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
        cwd: workspace.path,
        timeout: 300_000,
      });
      return { exitCode: 0, output: stdout + stderr };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        output: (e.stdout ?? '') + (e.stderr ?? e.message ?? ''),
      };
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function currentBranch(worktreeDir: string): Promise<string | null> {
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd: worktreeDir,
      encoding: 'utf8',
    });
    return result.stdout?.trim() || null;
  } catch {
    return null;
  }
}
