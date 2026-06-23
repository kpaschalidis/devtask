import type {
  MissionDefinition,
  ValidationContract,
  Feature,
  Milestone,
  ValidationAssertion,
  ValidationFinding,
  WorkerHandoff,
  ValidationHandoff,
  OrchestratorRepairDecision,
  MissionSnapshot,
  ApprovedSpec,
  SpecDocument,
} from '../domain/types.js';

export interface CreateValidationContractAssignment {
  invocationId: string;
  goal: string;
  context: string;
}

export interface PlanMissionAssignment {
  invocationId: string;
  goal: string;
  context: string;
  validationContract: ValidationContract;
}

export interface ReviseMissionAssignment {
  invocationId: string;
  definition: MissionDefinition;
  instruction: string;
}

export interface ImplementFeatureAssignment {
  invocationId: string;
  feature: Feature;
  milestone: Milestone;
  snapshot: MissionSnapshot;
}

export interface ValidateMilestoneAssignment {
  invocationId: string;
  milestone: Milestone;
  roundNumber: number;
  assertions: ValidationAssertion[];
  snapshot: MissionSnapshot;
}

export interface ReviewFindingsAssignment {
  invocationId: string;
  milestone: Milestone;
  findings: ValidationFinding[];
  snapshot: MissionSnapshot;
}

export interface ReviseDefinitionAssignment {
  invocationId: string;
  instruction: string;
  currentDefinition: MissionDefinition;
  snapshot: MissionSnapshot;
}

export interface MissionPlanner {
  createValidationContract(assignment: CreateValidationContractAssignment): Promise<ValidationContract>;
  planMission(assignment: PlanMissionAssignment): Promise<MissionDefinition>;
  reviseMission(assignment: ReviseMissionAssignment): Promise<MissionDefinition>;
}

export interface MissionWorker {
  implement(assignment: ImplementFeatureAssignment): Promise<WorkerHandoff>;
}

export interface MissionValidator {
  validate(assignment: ValidateMilestoneAssignment): Promise<ValidationHandoff>;
}

export interface MissionOrchestrator {
  reviewFindings(assignment: ReviewFindingsAssignment): Promise<OrchestratorRepairDecision>;
  reviseDefinition(assignment: ReviseDefinitionAssignment): Promise<MissionDefinition>;
}

export interface MissionAgents {
  planner: MissionPlanner;
  worker: MissionWorker;
  validator: MissionValidator;
  orchestrator: MissionOrchestrator;
}

export interface DraftSpecAssignment {
  invocationId: string;
  goal: string;
  context: string;
}

export interface ReviseSpecAssignment {
  invocationId: string;
  spec: SpecDocument;
  instruction: string;
}

export interface ImplementSpecAssignment {
  invocationId: string;
  spec: ApprovedSpec;
}

export interface SpecPlanner {
  draftSpec(assignment: DraftSpecAssignment): Promise<SpecDocument>;
  reviseSpec(assignment: ReviseSpecAssignment): Promise<SpecDocument>;
  implement(assignment: ImplementSpecAssignment): Promise<WorkerHandoff>;
}
