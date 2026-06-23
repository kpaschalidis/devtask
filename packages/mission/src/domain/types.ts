export const SCHEMA_VERSION = 1;

export type MissionStatus =
  | 'draft'
  | 'awaiting-approval'
  | 'ready'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed';

export type FeatureKind = 'planned' | 'repair';

export interface ValidationAssertion {
  id: string;
  description: string;
  milestoneIds: string[];
}

export interface ValidationContract {
  assertions: ValidationAssertion[];
}

export interface Milestone {
  id: string;
  name: string;
  order: number;
}

export interface Feature {
  id: string;
  kind: FeatureKind;
  milestoneId: string;
  description: string;
}

export interface FeatureDependency {
  featureId: string;
  dependsOnId: string;
}

export interface ExecutionPolicy {
  maxFeatureAttempts: number;
  maxValidationRounds: number;
  concurrency: number;
}

export interface MissionDefinition {
  id: string;
  version: number;
  goal: string;
  context: string;
  validationContract: ValidationContract;
  milestones: Milestone[];
  features: Feature[];
  featureDependencies: FeatureDependency[];
  executionPolicy: ExecutionPolicy;
}

export interface AssertionResult {
  assertionId: string;
  passed: boolean;
  notes: string;
}

export type FindingSeverity = 'critical' | 'major' | 'minor';

export interface ValidationFinding {
  id: string;
  assertionId: string;
  description: string;
  severity: FindingSeverity;
}

export interface WorkerHandoff {
  invocationId: string;
  featureId: string;
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  checksPerformed: string[];
  artifactRefs: string[];
  blockerInfo: string | null;
  knowledgeUpdates: string[];
}

export interface ValidationHandoff {
  invocationId: string;
  milestoneId: string;
  validationRound: number;
  status: 'passed' | 'failed' | 'blocked';
  assertionResults: AssertionResult[];
  evidenceRefs: string[];
  findings: ValidationFinding[];
  environmentBlockers: string[];
}

export interface RepairFeatureSpec {
  id: string;
  milestoneId: string;
  description: string;
  dependencies: string[];
}

export interface OrchestratorRepairDecision {
  invocationId: string;
  findingIds: string[];
  repairFeatures: RepairFeatureSpec[];
  addressedAssertionIds: string[];
  explanation: string | null;
  safeToRepair: boolean;
}

export interface OrchestratorRoundRecord {
  milestoneId: string;
  validationRound: number;
  decision: OrchestratorRepairDecision;
  recordedAt: string;
}

export interface FeatureAttempt {
  invocationId: string;
  featureId: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  handoff: WorkerHandoff | null;
}

export interface ValidationRound {
  invocationId: string;
  milestoneId: string;
  roundNumber: number;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'passed' | 'failed' | 'blocked';
  handoff: ValidationHandoff | null;
}

export interface ActiveInvocation {
  invocationId: string;
  type: 'feature' | 'validation' | 'orchestrator' | 'redirect';
  featureId?: string;
  milestoneId?: string;
  startedAt: string;
}

export interface Redirect {
  invocationId: string;
  instruction: string;
  requestedAt: string;
  appliedAt: string | null;
  previousDefinitionVersion: number;
}

export interface MissionSnapshot {
  id: string;
  schemaVersion: number;
  revision: number;
  status: MissionStatus;
  definition: MissionDefinition | null;
  /** Tracks definition.version at last approval. Execution is only allowed when this equals definition.version. */
  approvedDefinitionVersion: number | null;
  approvedAt: string | null;
  featureAttempts: FeatureAttempt[];
  validationRounds: ValidationRound[];
  orchestratorDecisions: OrchestratorRoundRecord[];
  activeInvocations: ActiveInvocation[];
  redirects: Redirect[];
  pauseReason: string | null;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MissionAction =
  | { type: 'ImplementFeature'; featureId: string; invocationId: string; milestoneId: string }
  | { type: 'ValidateMilestone'; milestoneId: string; invocationId: string; roundNumber: number }
  | { type: 'RequestOrchestratorRepair'; milestoneId: string; invocationId: string; findings: ValidationFinding[] }
  | { type: 'CompleteMission' }
  | { type: 'BlockMission'; reason: string };

export type RecoverOutcome = 'completed' | 'passed' | 'failed' | 'blocked';

export interface RecoverInvocationInput {
  missionId: string;
  invocationId: string;
  outcome: RecoverOutcome;
  reason?: string;
  handoff?: WorkerHandoff | ValidationHandoff;
}

export interface CreateMissionInput {
  goal: string;
  context: string;
}

export interface MissionDefinitionValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface MissionDefinitionValidation {
  valid: boolean;
  errors: MissionDefinitionValidationError[];
}

export interface AdvanceResult {
  action: MissionAction | null;
  snapshot: MissionSnapshot;
}

export interface RunOptions {
  maxActions?: number;
}

export interface RunResult {
  snapshot: MissionSnapshot;
  actionsExecuted: number;
  stoppedReason: 'completed' | 'paused' | 'awaiting-approval' | 'blocked' | 'failed' | 'limit';
}

export interface CreateSpecInput {
  goal: string;
  context: string;
}

export interface SpecDocument {
  id: string;
  version: number;
  goal: string;
  context: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecValidation {
  valid: boolean;
  errors: string[];
}

export interface ApprovedSpec {
  spec: SpecDocument;
  approvedVersion: number;
  approvedDigest: string;
  approvedAt: string;
}
