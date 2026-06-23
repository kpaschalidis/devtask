import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeWorkspaceDriver } from '../src/adapters/git-worktree/index.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GitWorktreeWorkspaceDriver.removeWorkspace', () => {
  it('removes a verified registered worktree', async () => {
    const fixture = createRepo();
    await fixture.driver.removeWorkspace(fixture.workspace);
    expect(fs.existsSync(fixture.workspace.path)).toBe(false);
  });

  it('is idempotent when the worktree has already been removed', async () => {
    const fixture = createRepo();
    await fixture.driver.removeWorkspace(fixture.workspace);
    await expect(fixture.driver.removeWorkspace(fixture.workspace)).resolves.toBeUndefined();
  });

  it('does not delete an unrelated directory', async () => {
    const fixture = createRepo();
    const unrelated = path.join(fixture.root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
    await expect(fixture.driver.removeWorkspace({ ...fixture.workspace, path: unrelated })).rejects.toThrow('unregistered worktree');
    expect(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('treats an absent stale handle as already removed', async () => {
    const fixture = createRepo();
    await expect(fixture.driver.removeWorkspace({ ...fixture.workspace, path: path.join(fixture.root, 'missing') })).resolves.toBeUndefined();
  });

  it('preserves the directory if git removal fails', async () => {
    const fixture = createRepo();
    fs.writeFileSync(path.join(fixture.workspace.path, 'untracked.txt'), 'keep');
    git(fixture.workspace.repoPath, 'worktree', 'lock', fixture.workspace.path);
    await expect(fixture.driver.removeWorkspace(fixture.workspace)).rejects.toThrow();
    expect(fs.existsSync(path.join(fixture.workspace.path, 'untracked.txt'))).toBe(true);
  });
});

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kernel-worktree-'));
  tempDirs.push(root);
  const repoPath = path.join(root, 'repo');
  const worktreePath = path.join(root, 'worktree');
  fs.mkdirSync(repoPath);
  git(repoPath, 'init');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'test');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'worktree', 'add', '-b', 'test-worktree', worktreePath);
  return {
    root,
    driver: new GitWorktreeWorkspaceDriver(),
    workspace: { path: worktreePath, branch: 'test-worktree', repoPath },
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
