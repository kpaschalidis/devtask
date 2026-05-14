import path from 'node:path';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RuntimeBackend } from '../ports/runtime-backend.js';
import type { PublishProvider } from '../ports/publish-provider.js';
import type { TaskStore } from '../ports/store.js';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const taskCtxSchema = z.object({
  workId: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  threadId: z.string(),
  workspacePath: z.string(),
});

const verifiedCtxSchema = taskCtxSchema.extend({
  passed: z.boolean(),
  verifyOutput: z.string(),
});

// ---------------------------------------------------------------------------
// Ports required by the task pipeline
// ---------------------------------------------------------------------------

export interface TaskPipelinePorts {
  agentRunner: AgentRunner;
  runtimeBackend: RuntimeBackend;
  publishProvider: PublishProvider | null;
  tasks: TaskStore;
  workspacesRoot: string;
}

// ---------------------------------------------------------------------------
// Factory — closes over ports so steps stay self-contained
// ---------------------------------------------------------------------------

export function createTaskPipeline(ports: TaskPipelinePorts) {
  const { agentRunner, runtimeBackend, publishProvider, tasks, workspacesRoot } = ports;

  function workspacePath(workId: string, taskId: string): string {
    return path.join(workspacesRoot, workId, taskId);
  }

  // ── run ──────────────────────────────────────────────────────────────────
  // Starts the agent to implement the task. Suspends if the agent requests
  // human input. On resume, sends the answer and continues streaming.

  const runStep = createStep({
    id: 'run',
    inputSchema: z.object({ workId: z.string(), taskId: z.string() }),
    outputSchema: taskCtxSchema,
    suspendSchema: z.object({ question: z.string(), sessionId: z.string(), threadId: z.string() }),
    resumeSchema: z.object({ answer: z.string(), sessionId: z.string(), threadId: z.string() }),
    execute: async ({ inputData, suspend, resumeData }) => {
      const { workId, taskId } = inputData;
      const task = tasks.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      if (resumeData) {
        const session = { id: resumeData.sessionId, threadId: resumeData.threadId };
        await agentRunner.sendInput?.(session, resumeData.answer);
        for await (const event of agentRunner.run(session, '')) {
          if (event.kind === 'input_required') {
            await suspend({ question: event.prompt, sessionId: session.id, threadId: session.threadId });
            return { workId, taskId, sessionId: session.id, threadId: session.threadId, workspacePath: workspacePath(workId, taskId) };
          }
          if (event.kind === 'completed' || event.kind === 'turn_complete') break;
          if (event.kind === 'failed') throw new Error(event.error);
        }
        return { workId, taskId, sessionId: session.id, threadId: session.threadId, workspacePath: workspacePath(workId, taskId) };
      }

      const workspace = await runtimeBackend.createWorkspace(workId, taskId, task.repoPath);
      const session = await agentRunner.start(workspace.path);

      tasks.save({ ...task, sessionHandle: { id: session.id, threadId: session.threadId }, updatedAt: new Date().toISOString() });

      const prompt = buildImplementationPrompt(task.title, task.description);
      for await (const event of agentRunner.run(session, prompt)) {
        if (event.kind === 'input_required') {
          await suspend({ question: event.prompt, sessionId: session.id, threadId: session.threadId });
          return { workId, taskId, sessionId: session.id, threadId: session.threadId, workspacePath: workspace.path };
        }
        if (event.kind === 'completed' || event.kind === 'turn_complete') break;
        if (event.kind === 'failed') throw new Error(event.error);
      }

      return { workId, taskId, sessionId: session.id, threadId: session.threadId, workspacePath: workspace.path };
    },
  });

  // ── verify ────────────────────────────────────────────────────────────────
  // Runs the task's verify script and reports whether it passed.

  const verifyStep = createStep({
    id: 'verify',
    inputSchema: taskCtxSchema,
    outputSchema: verifiedCtxSchema,
    execute: async ({ inputData }) => {
      const { workId, taskId } = inputData;
      const task = tasks.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const ws = {
        path: inputData.workspacePath,
        workId,
        taskId,
        branch: null as string | null,
        repoPath: task.repoPath,
      };
      const script = task.verifyScript ?? 'echo "no verify script defined"';
      const result = await runtimeBackend.runScript(ws, script);

      return { ...inputData, passed: result.exitCode === 0, verifyOutput: result.output };
    },
  });

  // ── fix ───────────────────────────────────────────────────────────────────
  // Runs the agent with a fix prompt and re-verifies. Used in a .dountil()
  // loop until verification passes. Skips work if already passed.

  const fixStep = createStep({
    id: 'fix',
    inputSchema: verifiedCtxSchema,
    outputSchema: verifiedCtxSchema,
    execute: async ({ inputData }) => {
      if (inputData.passed) return inputData;

      const { workId, taskId } = inputData;
      const task = tasks.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const session = { id: inputData.sessionId, threadId: inputData.threadId };
      const fixPrompt = buildFixPrompt(task.title, inputData.verifyOutput);

      for await (const event of agentRunner.run(session, fixPrompt)) {
        if (event.kind === 'completed' || event.kind === 'turn_complete') break;
        if (event.kind === 'failed') throw new Error(event.error);
      }

      const ws = {
        path: inputData.workspacePath,
        workId,
        taskId,
        branch: null as string | null,
        repoPath: task.repoPath,
      };
      const script = task.verifyScript ?? 'echo "no verify script defined"';
      const result = await runtimeBackend.runScript(ws, script);

      return { ...inputData, passed: result.exitCode === 0, verifyOutput: result.output };
    },
  });

  // ── review ────────────────────────────────────────────────────────────────
  // Gate: suspends for human approval before creating the PR.

  const reviewStep = createStep({
    id: 'review',
    inputSchema: verifiedCtxSchema,
    outputSchema: verifiedCtxSchema.extend({ approved: z.boolean() }),
    suspendSchema: z.object({ reason: z.string() }),
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, suspend, resumeData }) => {
      if (resumeData) return { ...inputData, approved: resumeData.approved };
      await suspend({ reason: 'Review implementation before creating PR' });
      return { ...inputData, approved: false };
    },
  });

  // ── pr ────────────────────────────────────────────────────────────────────
  // Creates a pull request. If the review gate was rejected, skips.

  const prStep = createStep({
    id: 'pr',
    inputSchema: verifiedCtxSchema.extend({ approved: z.boolean() }),
    outputSchema: z.object({ prUrl: z.string() }),
    execute: async ({ inputData }) => {
      if (!inputData.approved || !publishProvider) return { prUrl: '' };

      const task = tasks.getById(inputData.taskId);
      const branch = `devtask/${inputData.workId.slice(0, 8)}-${inputData.taskId.slice(0, 8)}`;
      const pr = await publishProvider.createPr({
        branch,
        base: 'main',
        title: task?.title ?? branch,
        body: task?.description ?? '',
        draft: false,
        labels: ['devtask'],
      });

      return { prUrl: pr.url };
    },
  });

  // ── workflow ──────────────────────────────────────────────────────────────

  const taskWorkflow = createWorkflow({
    id: 'task-pipeline',
    inputSchema: z.object({ workId: z.string(), taskId: z.string() }),
    outputSchema: z.object({ prUrl: z.string() }),
  })
    .then(runStep)
    .then(verifyStep)
    .dountil(fixStep, async ({ inputData }) => inputData?.passed ?? true)
    .then(reviewStep)
    .then(prStep)
    .commit();

  return taskWorkflow;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function buildImplementationPrompt(title: string, description: string | null): string {
  return [
    `Implement the following task: ${title}`,
    description ? `\nDetails:\n${description}` : '',
    '\nWhen done, run any existing tests to verify your changes are correct.',
  ].join('');
}

function buildFixPrompt(title: string, verifyOutput: string): string {
  return [
    `The verification for task "${title}" failed with the following output:`,
    '```',
    verifyOutput.slice(0, 4000),
    '```',
    'Fix the issues and make the verification pass.',
  ].join('\n');
}
