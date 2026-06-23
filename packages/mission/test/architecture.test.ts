import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const DISALLOWED_IMPORTS = [
  '@devtask/agent-kernel',
  'agent-kernel',
  'simple-git',
  'nodegit',
  'isomorphic-git',
  'node-pty',
  'commander',
  'chalk',
  'inquirer',
  'node:child_process',
  'node:fs',
  'node:path',
];

const ALLOWED_NODE_BUILTINS = new Set(['node:crypto', 'node:sqlite']);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('architecture', () => {
  it('src/ has no disallowed imports', () => {
    const srcDir = join(new URL('.', import.meta.url).pathname, '../src');
    const files = collectSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const disallowed of DISALLOWED_IMPORTS) {
        if (content.includes(`from '${disallowed}`) || content.includes(`require('${disallowed}`)) {
          violations.push(`${file}: imports '${disallowed}'`);
        }
      }

      const nodeImportRegex = /from ['"]node:([^'"]+)['"]/g;
      let match;
      while ((match = nodeImportRegex.exec(content)) !== null) {
        const imported = `node:${match[1]}`;
        if (!ALLOWED_NODE_BUILTINS.has(imported)) {
          violations.push(`${file}: imports disallowed node builtin '${imported}'`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`Architecture violations:\n${violations.join('\n')}`);
    }
  });

  it('src/ does not import from devtask or upstream packages', () => {
    const srcDir = join(new URL('.', import.meta.url).pathname, '../src');
    const files = collectSourceFiles(srcDir);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} should not import agent-kernel`).not.toContain("from '@devtask/agent-kernel'");
      expect(content, `${file} should not import from devtask src`).not.toMatch(/from ['"]\.\.\/\.\.\/\.\.\/src/);
    }
  });
});
