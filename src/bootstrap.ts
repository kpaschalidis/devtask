import path from 'node:path';
import { createPipeline } from './core/pipeline/pipeline.js';
import { implementPhase } from './phases/implement.js';
import { verifyPhase } from './phases/verify.js';
import { shipPhase } from './phases/ship.js';
import { refinePhase } from './phases/refine.js';
import { architectPhase } from './phases/architect.js';
import { createGate } from './core/pipeline/phase.js';
import { CodexAgentRunner } from './agent-codex/index.js';
import { LocalRuntimeBackend } from './runtime-local/index.js';
import { createSqliteStores } from './core/storage/sqlite.js';
import { consoleLogger } from './core/logging/index.js';
import type { Pipeline } from './core/pipeline/phase.js';
import type { SqliteCoreStores } from './core/storage/sqlite.js';
import type { DevtaskPaths } from './paths.js';
import type { DevtaskConfig } from './config.js';

export const PIPELINE_DB_NAME = 'pipeline.db';

export interface DevtaskPipelineHandle {
  pipeline: Pipeline;
  stores: SqliteCoreStores;
  close(): void;
}

export function createDevtaskPipeline(paths: DevtaskPaths, config: DevtaskConfig): DevtaskPipelineHandle {
  const stores = createSqliteStores(path.join(paths.baseDir, PIPELINE_DB_NAME));

  const agentRunner = new CodexAgentRunner({
    model: config.codex.model ?? undefined,
  });

  const runtimeBackend = new LocalRuntimeBackend({
    workspacesRoot: paths.worktreesDir,
  });

  const pipeline = createPipeline({
    workPhases: [
      refinePhase,
      createGate('spec-gate', (ctx) => ctx.stores.specs.getByWork(ctx.workId)),
      architectPhase,
      createGate('plan-gate', (ctx) => ctx.stores.graph.getByWork(ctx.workId)),
    ],
    taskPhases: { implement: implementPhase, verify: verifyPhase, ship: shipPhase },
    ports: { agentRunner, runtimeBackend, publishProvider: null, ciProvider: null, contextProvider: null },
    stores,
    logger: consoleLogger(),
    storageDir: paths.baseDir,
  });

  return { pipeline, stores, close: () => stores.close() };
}
