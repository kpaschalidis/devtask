# Mastra Migration Plan

## Goal
Replace the hand-rolled workflow engine, stage machine, gate/question system, and 5 SQLite stores
with Mastra. Keep only what Mastra cannot provide: Work/Task/Graph domain registry, scheduler,
and external integration ports.

## Packages
```
npm install @mastra/core zod
```
Zod is required by Mastra's step/workflow schema definitions.

## What changes in src/core/

### DELETE (Mastra owns this)
- engine/workflow-engine.ts
- engine/handler-registry.ts
- engine/stage-machine.ts
- engine/stage-handler.ts
- engine/event-bus.ts
- engine/defaults.ts
- engine/workflow-definition.ts
- domain/stage-attempt.ts
- domain/run-attempt.ts
- domain/artifact.ts
- domain/gate.ts
- domain/agent-question.ts
- events/domain-events.ts
- events/sqlite.ts
- events/store.ts
- events/store.test.ts
- policy/gate-policy.ts
- policy/retry-policy.ts
- policy/defaults.ts
- ports/event-subscriber.ts
- ports/context-provider.ts  (→ Mastra Skills)
- Storage classes: SqliteStageAttemptStore, SqliteRunAttemptStore, SqliteArtifactStore, SqliteGateStore, SqliteAgentQuestionStore

### KEEP
- engine/scheduler.ts + scheduler.test.ts
- domain/work.ts (add mastraRunId?: string)
- domain/task.ts (add mastraRunId?: string)
- domain/execution-graph.ts
- errors/index.ts
- logging/index.ts
- ports/agent-runner.ts
- ports/publish-provider.ts
- ports/ci-provider.ts
- ports/runtime-backend.ts (keep createWorkspace/removeWorkspace; drop runScript → LocalSandbox later)
- Storage: SqliteWorkStore, SqliteTaskStore, SqliteExecutionGraphStore

### NEW
- engine/task-pipeline.ts — Mastra workflow + steps for task execution
- engine/work-orchestrator.ts — simple async orchestrator using getReadyTasks

## Implementation Steps

### Step 1: Install packages
```
npm install @mastra/core zod
```

### Step 2: Domain — add mastraRunId
- Work: add `mastraRunId?: string`
- Task: add `mastraRunId?: string`

### Step 3: Slim ports/store.ts
Keep only WorkStore, TaskStore, ExecutionGraphStore interfaces.

### Step 4: Slim storage/sqlite.ts
Keep only SqliteWorkStore, SqliteTaskStore, SqliteExecutionGraphStore.
Update createSqliteStores() to return only those 3.

### Step 5: Create engine/task-pipeline.ts
Define Mastra steps and task workflow:
- Steps: runStep, checkStep, fixStep, reviewStep, prStep
- Each step: inputSchema = { workId, taskId }, execute = calls AgentRunner/ports
- Gate (human approval): suspend({ kind: 'gate', stage })
- Retry: per step `retries` config
- The workflow: runStep → checkStep → branch(success→reviewStep→prStep, fail→fixStep→loop)

### Step 6: Create engine/work-orchestrator.ts
- WorkOrchestrator class: startWork(), approveGate(), answerQuestion()
- Work pipeline: spec stage (calls Mastra or agent directly) → exec phase → done
- Exec phase: uses getReadyTasks scheduler, starts one Mastra task run per ready task
- Manages mastraRunId on Work/Task records

### Step 7: Update domain/index.ts exports

### Step 8: Delete dropped files

### Step 9: Type-check
```
npx tsc --noEmit
```

## Mastra API shape (from research)

```typescript
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const taskInputSchema = z.object({ workId: z.string(), taskId: z.string() });

const runStep = createStep({
  id: 'run',
  inputSchema: taskInputSchema,
  outputSchema: z.object({ success: z.boolean(), needsInput: z.boolean().optional() }),
  execute: async ({ context, suspend, runId }) => {
    // call AgentRunner
    // if needs human input: await suspend({ ... })
    return { success: true };
  },
});
```
