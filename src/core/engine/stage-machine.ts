import type { WorkflowDefinition, StageDefinition, StageTransition } from './workflow-definition.js';
import { CoreError } from '../errors/index.js';

export function getStageDefinition(pipeline: WorkflowDefinition, stage: string): StageDefinition {
  const def = pipeline.stages[stage];
  if (!def) throw new CoreError(`Unknown stage: '${stage}'`);
  return def;
}

export function nextStageName(transition: StageTransition): string | null {
  if ('goto' in transition) return transition.goto;
  return null;
}

export function isTerminalTransition(transition: StageTransition): boolean {
  return 'done' in transition || 'fail' in transition;
}

export function isFailTransition(transition: StageTransition): boolean {
  return 'fail' in transition;
}

export function validatePipeline(pipeline: WorkflowDefinition): void {
  if (!pipeline.stages[pipeline.entry]) {
    throw new CoreError(`Entry stage '${pipeline.entry}' not defined in pipeline`);
  }
  for (const [name, def] of Object.entries(pipeline.stages)) {
    for (const transition of [def.onSuccess, def.onFailure]) {
      if ('goto' in transition && !pipeline.stages[transition.goto]) {
        throw new CoreError(
          `Stage '${name}' transitions to unknown stage '${transition.goto}'`,
        );
      }
    }
  }
}
