import type {
  MissionDefinition,
  MissionDefinitionValidation,
  MissionDefinitionValidationError,
  OrchestratorRepairDecision,
  Milestone,
  ValidationFinding,
  ValidationHandoff,
  WorkerHandoff,
  Feature,
  FeatureDependency,
} from './types.js';

export function validateMissionDefinition(definition: MissionDefinition): MissionDefinitionValidation {
  const errors: MissionDefinitionValidationError[] = [];

  if (!definition.goal || definition.goal.trim().length === 0) {
    errors.push({ code: 'MISSING_GOAL', message: 'Mission must have a non-empty goal' });
  }

  const assertions = definition.validationContract?.assertions ?? [];
  if (assertions.length === 0) {
    errors.push({ code: 'MISSING_ASSERTIONS', message: 'Validation contract must have at least one assertion' });
  }

  const milestoneIds = new Set<string>();
  for (const milestone of definition.milestones) {
    if (milestoneIds.has(milestone.id)) {
      errors.push({ code: 'DUPLICATE_MILESTONE_ID', message: `Duplicate milestone ID: ${milestone.id}`, path: `milestones.${milestone.id}` });
    }
    milestoneIds.add(milestone.id);
  }

  const featureIds = new Set<string>();
  for (const feature of definition.features) {
    if (featureIds.has(feature.id)) {
      errors.push({ code: 'DUPLICATE_FEATURE_ID', message: `Duplicate feature ID: ${feature.id}`, path: `features.${feature.id}` });
    }
    featureIds.add(feature.id);
    if (!milestoneIds.has(feature.milestoneId)) {
      errors.push({ code: 'INVALID_MILESTONE_REF', message: `Feature ${feature.id} references unknown milestone ${feature.milestoneId}`, path: `features.${feature.id}.milestoneId` });
    }
  }

  const assertionIds = new Set<string>();
  for (const assertion of assertions) {
    if (assertionIds.has(assertion.id)) {
      errors.push({ code: 'DUPLICATE_ASSERTION_ID', message: `Duplicate assertion ID: ${assertion.id}`, path: `validationContract.assertions.${assertion.id}` });
    }
    assertionIds.add(assertion.id);
    for (const mId of assertion.milestoneIds) {
      if (!milestoneIds.has(mId)) {
        errors.push({ code: 'INVALID_MILESTONE_REF', message: `Assertion ${assertion.id} references unknown milestone ${mId}`, path: `validationContract.assertions.${assertion.id}.milestoneIds` });
      }
    }
  }

  for (const dep of definition.featureDependencies) {
    if (!featureIds.has(dep.featureId)) {
      errors.push({ code: 'INVALID_DEPENDENCY_REF', message: `Dependency references unknown feature ${dep.featureId}`, path: `featureDependencies` });
    }
    if (!featureIds.has(dep.dependsOnId)) {
      errors.push({ code: 'INVALID_DEPENDENCY_REF', message: `Dependency references unknown feature ${dep.dependsOnId}`, path: `featureDependencies` });
    }
  }

  if (isCyclic(definition.featureDependencies)) {
    errors.push({ code: 'CYCLIC_DEPENDENCY', message: 'Feature dependency graph is cyclic' });
  }

  const milestoneOrder = new Map<string, number>();
  for (const milestone of definition.milestones) {
    milestoneOrder.set(milestone.id, milestone.order);
  }

  const featureMilestone = new Map<string, string>();
  for (const feature of definition.features) {
    featureMilestone.set(feature.id, feature.milestoneId);
  }

  for (const dep of definition.featureDependencies) {
    const fromMilestone = featureMilestone.get(dep.featureId);
    const toMilestone = featureMilestone.get(dep.dependsOnId);
    if (fromMilestone && toMilestone && fromMilestone !== toMilestone) {
      const fromOrder = milestoneOrder.get(fromMilestone) ?? 0;
      const toOrder = milestoneOrder.get(toMilestone) ?? 0;
      if (toOrder > fromOrder) {
        errors.push({
          code: 'CROSS_MILESTONE_DEPENDENCY',
          message: `Feature ${dep.featureId} (milestone order ${fromOrder}) depends on feature ${dep.dependsOnId} (milestone order ${toOrder}) in a later milestone`,
          path: 'featureDependencies',
        });
      }
    }
  }

  for (const milestone of definition.milestones) {
    const hasAssertion = assertions.some((a) => a.milestoneIds.includes(milestone.id));
    if (!hasAssertion) {
      errors.push({ code: 'MILESTONE_NO_ASSERTION', message: `Milestone ${milestone.id} has no applicable validation assertions`, path: `milestones.${milestone.id}` });
    }
  }

  const policy = definition.executionPolicy;
  if (!policy || policy.maxFeatureAttempts < 1) {
    errors.push({ code: 'INVALID_POLICY', message: 'executionPolicy.maxFeatureAttempts must be >= 1', path: 'executionPolicy.maxFeatureAttempts' });
  }
  if (!policy || policy.maxValidationRounds < 1) {
    errors.push({ code: 'INVALID_POLICY', message: 'executionPolicy.maxValidationRounds must be >= 1', path: 'executionPolicy.maxValidationRounds' });
  }
  if (!policy || policy.concurrency < 1) {
    errors.push({ code: 'INVALID_POLICY', message: 'executionPolicy.concurrency must be >= 1', path: 'executionPolicy.concurrency' });
  }

  for (const feature of definition.features) {
    if (feature.kind === 'repair' && !milestoneIds.has(feature.milestoneId)) {
      errors.push({ code: 'REPAIR_INVALID_MILESTONE', message: `Repair feature ${feature.id} references unknown milestone ${feature.milestoneId}`, path: `features.${feature.id}.milestoneId` });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateOrchestratorDecision(
  decision: OrchestratorRepairDecision,
  assignment: { invocationId: string; milestone: Milestone; findings: ValidationFinding[] },
  definition: MissionDefinition,
): MissionDefinitionValidationError[] {
  const errors: MissionDefinitionValidationError[] = [];

  if (decision.invocationId !== assignment.invocationId) {
    errors.push({ code: 'INVOCATION_MISMATCH', message: 'Decision invocationId does not match assignment invocationId' });
  }

  const assignedFindingIds = new Set(assignment.findings.map((f) => f.id));
  const decisionFindingIds = new Set<string>();
  const duplicateFindingIds = new Set<string>();
  for (const fid of decision.findingIds) {
    if (decisionFindingIds.has(fid)) duplicateFindingIds.add(fid);
    decisionFindingIds.add(fid);
  }
  for (const fid of duplicateFindingIds) {
    errors.push({ code: 'DUPLICATE_FINDING_ID', message: `Decision references finding ID more than once: ${fid}` });
  }
  for (const fid of decision.findingIds) {
    if (!assignedFindingIds.has(fid)) {
      errors.push({ code: 'UNKNOWN_FINDING_ID', message: `Decision references finding ID not in assignment: ${fid}` });
    }
  }
  for (const fid of assignedFindingIds) {
    if (!decisionFindingIds.has(fid)) {
      errors.push({ code: 'MISSING_FINDING_ID', message: `Decision does not address assigned finding ID: ${fid}` });
    }
  }

  const assertionIds = new Set(
    definition.validationContract.assertions
      .filter((a) => a.milestoneIds.includes(assignment.milestone.id))
      .map((a) => a.id),
  );
  for (const aid of decision.addressedAssertionIds) {
    if (!assertionIds.has(aid)) {
      errors.push({ code: 'UNKNOWN_ASSERTION_ID', message: `Decision addresses assertion ID not assigned to milestone ${assignment.milestone.id}: ${aid}` });
    }
  }

  // Safe decision with no repair features while unresolved findings remain is invalid.
  if (decision.safeToRepair && decision.repairFeatures.length === 0 && assignment.findings.length > 0) {
    errors.push({
      code: 'SAFE_NO_REPAIRS_WITH_FINDINGS',
      message: 'Orchestrator declared safeToRepair=true with no repair features but findings remain unresolved',
    });
    return errors;
  }

  if (decision.safeToRepair) {
    const existingFeatureIds = new Set(definition.features.map((f) => f.id));
    const newRepairIds = new Set<string>();

    for (const rf of decision.repairFeatures) {
      if (rf.milestoneId !== assignment.milestone.id) {
        errors.push({
          code: 'REPAIR_WRONG_MILESTONE',
          message: `Repair feature ${rf.id} targets milestone ${rf.milestoneId} but must target failing milestone ${assignment.milestone.id}`,
        });
      }
      if (existingFeatureIds.has(rf.id)) {
        errors.push({ code: 'REPAIR_DUPLICATE_ID', message: `Repair feature ID ${rf.id} collides with existing feature` });
      }
      if (newRepairIds.has(rf.id)) {
        errors.push({ code: 'REPAIR_DUPLICATE_ID', message: `Duplicate repair feature ID: ${rf.id}` });
      }
      newRepairIds.add(rf.id);
    }

    const allIds = new Set([...existingFeatureIds, ...newRepairIds]);
    for (const rf of decision.repairFeatures) {
      for (const depId of rf.dependencies) {
        if (!allIds.has(depId)) {
          errors.push({ code: 'REPAIR_INVALID_DEP', message: `Repair feature ${rf.id} depends on unknown feature ${depId}` });
        }
      }
    }

    if (errors.length === 0) {
      const newFeatures: Feature[] = decision.repairFeatures.map((rf) => ({
        id: rf.id,
        kind: 'repair' as const,
        milestoneId: rf.milestoneId,
        description: rf.description,
      }));
      const newDeps: FeatureDependency[] = decision.repairFeatures.flatMap((rf) =>
        rf.dependencies.map((depId) => ({ featureId: rf.id, dependsOnId: depId })),
      );
      const updatedDef: MissionDefinition = {
        ...definition,
        features: [...definition.features, ...newFeatures],
        featureDependencies: [...definition.featureDependencies, ...newDeps],
      };
      const defValidation = validateMissionDefinition(updatedDef);
      errors.push(...defValidation.errors);
    }
  }

  return errors;
}

export function validateWorkerHandoff(handoff: WorkerHandoff, assignment: { invocationId: string; featureId: string }): string[] {
  const errors: string[] = [];
  if (handoff.invocationId !== assignment.invocationId) {
    errors.push(`invocationId mismatch: expected ${assignment.invocationId}, got ${handoff.invocationId}`);
  }
  if (handoff.featureId !== assignment.featureId) {
    errors.push(`featureId mismatch: expected ${assignment.featureId}, got ${handoff.featureId}`);
  }
  if (handoff.status === 'blocked' && !handoff.blockerInfo) {
    errors.push('blocked status requires non-empty blockerInfo');
  }
  return errors;
}

export function validateValidatorHandoff(
  handoff: ValidationHandoff,
  assignment: { invocationId: string; milestoneId: string; roundNumber: number; assertionIds: string[] },
): string[] {
  const errors: string[] = [];
  if (handoff.invocationId !== assignment.invocationId) {
    errors.push(`invocationId mismatch: expected ${assignment.invocationId}, got ${handoff.invocationId}`);
  }
  if (handoff.milestoneId !== assignment.milestoneId) {
    errors.push(`milestoneId mismatch: expected ${assignment.milestoneId}, got ${handoff.milestoneId}`);
  }
  if (handoff.validationRound !== assignment.roundNumber) {
    errors.push(`validationRound mismatch: expected ${assignment.roundNumber}, got ${handoff.validationRound}`);
  }

  const expected = new Set(assignment.assertionIds);
  const covered = handoff.assertionResults.map((r) => r.assertionId);
  const coveredSet = new Set(covered);
  const missing = [...expected].filter((id) => !coveredSet.has(id));
  const extra = covered.filter((id) => !expected.has(id));
  const dups = covered.filter((id, i) => covered.indexOf(id) !== i);
  if (missing.length > 0) errors.push(`missing assertion results: ${missing.join(', ')}`);
  if (extra.length > 0) errors.push(`extra assertion results not in assignment: ${extra.join(', ')}`);
  if (dups.length > 0) errors.push(`duplicate assertion results: ${dups.join(', ')}`);

  const findingIds = handoff.findings.map((f) => f.id);
  const dupFindings = findingIds.filter((id, i) => findingIds.indexOf(id) !== i);
  if (dupFindings.length > 0) errors.push(`duplicate finding IDs: ${dupFindings.join(', ')}`);
  const unrelatedFindings = handoff.findings
    .filter((f) => !expected.has(f.assertionId))
    .map((f) => `${f.id}:${f.assertionId}`);
  if (unrelatedFindings.length > 0) {
    errors.push(`findings reference assertions not in assignment: ${unrelatedFindings.join(', ')}`);
  }

  if (handoff.status === 'passed') {
    const allPassed = handoff.assertionResults.every((r) => r.passed);
    if (!allPassed) errors.push('passed status requires all assertion results to pass');
    if (handoff.findings.length > 0) errors.push('passed status requires no findings');
    if (handoff.environmentBlockers.length > 0) errors.push('passed status requires no environment blockers');
  } else if (handoff.status === 'failed') {
    const hasFailedAssertion = handoff.assertionResults.some((r) => !r.passed);
    if (!hasFailedAssertion && handoff.findings.length === 0) {
      errors.push('failed status requires at least one failed assertion or finding');
    }
  } else if (handoff.status === 'blocked') {
    if (handoff.environmentBlockers.length === 0) {
      errors.push('blocked status requires at least one environment blocker');
    }
  }

  return errors;
}

function isCyclic(deps: Array<{ featureId: string; dependsOnId: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const dep of deps) {
    if (!adj.has(dep.featureId)) adj.set(dep.featureId, []);
    adj.get(dep.featureId)!.push(dep.dependsOnId);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const neighbor of adj.get(node) ?? []) {
      if (dfs(neighbor)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (dfs(node)) return true;
  }
  return false;
}
