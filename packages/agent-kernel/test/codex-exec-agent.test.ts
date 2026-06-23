import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/runtime/runtime.js';
import { CodexExecAgent } from '../src/adapters/codex/exec-agent.js';

describe('CodexExecAgent', () => {
  const createdHomes: string[] = [];

  afterEach(async () => {
    await Promise.all(createdHomes.splice(0).map(async (home) => {
      const { rm } = await import('node:fs/promises');
      await rm(home, { recursive: true, force: true });
    }));
  });

  it('streams stdout and exposes transcript-backed session info', async () => {
    const taskDir = await makeTempDir('agent-kernel-codex-exec-');
    createdHomes.push(taskDir);
    const transcriptDir = `${taskDir}/codex-sessions/session-1/.codex/sessions/2026/06/23`;
    const transcriptPath = `${transcriptDir}/thread.jsonl`;

    const child = createMockChild();
    const agent = new CodexExecAgent({
      model: 'gpt-5',
      addDirs: ['/tmp/project'],
      binaryPathResolver: async () => '/bin/codex',
      spawnProcess: () => child as never,
    });
    const handle = await agent.createSession({
      workspacePath: '/tmp/project',
      sessionId: 'session-1',
      environment: { DEVTASK_TASK_DIR: taskDir },
      instructions: {},
    });

    await agent.sendMessage(handle, noopRuntime(), 'do it');
    const eventPromise = collectEvents(agent.readEvents(handle, noopRuntime()));

    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/project', timestamp: '2026-06-23T00:00:00.000Z', threadId: 'thread-1' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
      ].join('\n') + '\n',
      'utf8',
    );

    child.stdout.emit('data', 'hello');
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0);

    const events = await eventPromise;
    const info = await agent.getSessionInfo(handle);

    expect(events).toEqual([
      { kind: 'output', text: 'hello' },
      { kind: 'completed' },
    ]);
    expect(info?.agentSessionId).toBe('thread-1');
    expect(info?.summary).toBe('done');
  });
});

async function collectEvents(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function noopRuntime(): Runtime {
  return {
    name: 'noop',
    create: async () => {
      throw new Error('noop');
    },
    destroy: async () => {},
    sendMessage: async () => {},
    isAlive: async () => true,
  };
}

function createMockChild(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

async function makeTempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), prefix));
}
