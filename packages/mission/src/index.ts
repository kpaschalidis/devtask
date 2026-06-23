export { SCHEMA_VERSION } from './domain/types.js';
export type {
  MissionStatus,
  FeatureKind,
  ValidationContract,
  ValidationAssertion,
  Milestone,
  Feature,
  FeatureDependency,
  ExecutionPolicy,
  MissionDefinition,
  AssertionResult,
  FindingSeverity,
  ValidationFinding,
  WorkerHandoff,
  ValidationHandoff,
  RepairFeatureSpec,
  OrchestratorRepairDecision,
  OrchestratorRoundRecord,
  FeatureAttempt,
  ValidationRound,
  ActiveInvocation,
  Redirect,
  MissionSnapshot,
  MissionAction,
  RecoverOutcome,
  RecoverInvocationInput,
  CreateMissionInput,
  MissionDefinitionValidationError,
  MissionDefinitionValidation,
  AdvanceResult,
  RunOptions,
  RunResult,
  CreateSpecInput,
  SpecDocument,
  SpecValidation,
  ApprovedSpec,
} from './domain/types.js';

export {
  ValidationContractSchema,
  ExecutionPolicySchema,
  ValidationAssertionSchema,
  MilestoneSchema,
  FeatureSchema,
  FeatureDependencySchema,
  MissionDefinitionSchema,
  CreateMissionInputSchema,
  AssertionResultSchema,
  ValidationFindingSchema,
  WorkerHandoffSchema,
  ValidationHandoffSchema,
  RepairFeatureSpecSchema,
  OrchestratorRepairDecisionSchema,
  SpecDocumentSchema,
  CreateSpecInputSchema,
} from './domain/schemas.js';

export { validateMissionDefinition, validateOrchestratorDecision, validateWorkerHandoff, validateValidatorHandoff } from './domain/validation.js';
export { deriveNextAction, isFeatureComplete, isMilestoneValidationPassed } from './domain/scheduler.js';

export {
  MissionError,
  InvalidStateError,
  StaleRevisionError,
  InvalidHandoffError,
  MissingMissionError,
  InvalidDefinitionError,
  MissionAlreadyExistsError,
} from './domain/errors.js';

export type { MissionStore, MissionCommit, MissionEvent, NewMissionEvent } from './store/store.js';
export { InMemoryMissionStore } from './store/in-memory-store.js';
export { SqliteMissionStore } from './store/sqlite-store.js';

export type {
  CreateValidationContractAssignment,
  PlanMissionAssignment,
  ReviseMissionAssignment,
  ImplementFeatureAssignment,
  ValidateMilestoneAssignment,
  ReviewFindingsAssignment,
  ReviseDefinitionAssignment,
  MissionPlanner,
  MissionWorker,
  MissionValidator,
  MissionOrchestrator,
  MissionAgents,
  DraftSpecAssignment,
  ReviseSpecAssignment,
  ImplementSpecAssignment,
  SpecPlanner,
} from './ports/ports.js';

export { SpecWorkflow } from './spec/spec-workflow.js';
export { MissionController } from './mission/mission-controller.js';

// Factory functions for ergonomic construction.
import { MissionController } from './mission/mission-controller.js';
import { SpecWorkflow } from './spec/spec-workflow.js';
import type { MissionAgents } from './ports/ports.js';
import type { MissionStore } from './store/store.js';
import type { SpecPlanner } from './ports/ports.js';

export function createMissionController(store: MissionStore, agents: MissionAgents): MissionController {
  return new MissionController(store, agents);
}

export function createSpecWorkflow(planner: SpecPlanner): SpecWorkflow {
  return new SpecWorkflow(planner);
}
