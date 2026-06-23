import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceCreateRequest, WorkspaceDriver, WorkspaceHandle, ScriptResult } from '../../workspace/workspace-provider.js';
import { normalizeArtifactPrefix, type ArtifactNamingConfig } from '../../shared/naming.js';

const execFileAsync = promisify(execFile);

export class GitWorktreeWorkspaceDriver implements WorkspaceDriver {
  private readonly artifactPrefix: string;

  constructor(config: ArtifactNamingConfig = {}) {
    this.artifactPrefix = normalizeArtifactPrefix(config.artifactPrefix, 'workspace');
  }

  async createWorkspace(input: WorkspaceCreateRequest): Promise<WorkspaceHandle> {
    await createGitWorktree(input.repoPath, input.targetPath, input.branchName ?? null);
    return {
      path: input.targetPath,
      branch: await currentBranch(input.targetPath),
      repoPath: input.repoPath,
    };
  }

  async removeWorkspace(workspace: WorkspaceHandle): Promise<void> {
    if (!fs.existsSync(workspace.path)) return;

    const registered = await registeredWorktreePaths(workspace.repoPath);
    const workspacePath = await fs.promises.realpath(workspace.path);
    if (!registered.has(workspacePath)) {
      throw new Error(`Refusing to remove unregistered worktree: ${workspace.path}`);
    }

    await execFileAsync('git', ['worktree', 'remove', '--force', workspace.path], {
      cwd: workspace.repoPath,
    });
  }

  async runScript(workspace: WorkspaceHandle, script: string): Promise<ScriptResult> {
    const scriptPath = path.join(
      workspace.path,
      `.${this.artifactPrefix}-script-${crypto.randomUUID()}.sh`,
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

async function registeredWorktreePaths(repoPath: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
  });
  const paths = stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
  const resolved = await Promise.all(paths.map(async (worktreePath) => {
    try {
      return await fs.promises.realpath(worktreePath);
    } catch {
      return path.resolve(worktreePath);
    }
  }));
  return new Set(resolved);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createGitWorktree(repoPath: string, targetPath: string, branchName: string | null): Promise<void> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) return;
  if (!branchName) {
    await execFileAsync('git', ['worktree', 'add', targetPath], { cwd: repoPath });
    return;
  }
  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branchName, targetPath], { cwd: repoPath });
  } catch {
    await execFileAsync('git', ['worktree', 'add', targetPath, branchName], { cwd: repoPath });
  }
}

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
