import { z } from 'zod';

export const ValidationContractSchema = z.object({
  assertions: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    milestoneIds: z.array(z.string().min(1)),
  })),
});

export const ExecutionPolicySchema = z.object({
  maxFeatureAttempts: z.number().int().min(1),
  maxValidationRounds: z.number().int().min(1),
  concurrency: z.number().int().min(1),
});

export const ValidationAssertionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  milestoneIds: z.array(z.string().min(1)),
});

export const MilestoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int().min(0),
});

export const FeatureSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['planned', 'repair']),
  milestoneId: z.string().min(1),
  description: z.string().min(1),
});

export const FeatureDependencySchema = z.object({
  featureId: z.string().min(1),
  dependsOnId: z.string().min(1),
});

export const MissionDefinitionSchema = z.object({
  id: z.string().min(1),
  goal: z.string(),
  context: z.string(),
  validationContract: z.object({
    assertions: z.array(ValidationAssertionSchema),
  }),
  milestones: z.array(MilestoneSchema),
  features: z.array(FeatureSchema),
  featureDependencies: z.array(FeatureDependencySchema),
  executionPolicy: ExecutionPolicySchema,
});

export const CreateMissionInputSchema = z.object({
  goal: z.string().min(1),
  context: z.string(),
});

export const AssertionResultSchema = z.object({
  assertionId: z.string().min(1),
  passed: z.boolean(),
  notes: z.string(),
});

export const ValidationFindingSchema = z.object({
  id: z.string().min(1),
  assertionId: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['critical', 'major', 'minor']),
});

export const WorkerHandoffSchema = z.object({
  invocationId: z.string().min(1),
  featureId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'blocked']),
  summary: z.string(),
  checksPerformed: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  blockerInfo: z.string().nullable(),
  knowledgeUpdates: z.array(z.string()),
});

export const ValidationHandoffSchema = z.object({
  invocationId: z.string().min(1),
  milestoneId: z.string().min(1),
  validationRound: z.number().int().min(1),
  status: z.enum(['passed', 'failed', 'blocked']),
  assertionResults: z.array(AssertionResultSchema),
  evidenceRefs: z.array(z.string()),
  findings: z.array(ValidationFindingSchema),
  environmentBlockers: z.array(z.string()),
});

export const RepairFeatureSpecSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.string().min(1),
  description: z.string().min(1),
  dependencies: z.array(z.string()),
});

export const OrchestratorRepairDecisionSchema = z.object({
  invocationId: z.string().min(1),
  findingIds: z.array(z.string()),
  repairFeatures: z.array(RepairFeatureSpecSchema),
  addressedAssertionIds: z.array(z.string()),
  explanation: z.string().nullable(),
  safeToRepair: z.boolean(),
});

export const SpecDocumentSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  context: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateSpecInputSchema = z.object({
  goal: z.string().min(1),
  context: z.string(),
});
