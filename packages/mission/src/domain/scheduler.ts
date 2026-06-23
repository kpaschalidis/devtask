import crypto from 'node:crypto';
import type { MissionSnapshot, MissionAction, ValidationFinding } from './types.js';

export function deriveNextAction(snapshot: MissionSnapshot): MissionAction | null {
  if (snapshot.status !== 'ready' && snapshot.status !== 'running') return null;
  if (!snapshot.definition) return null;

  const def = snapshot.definition;
  const sortedMilestones = [...def.milestones].sort((a, b) => a.order - b.order);
  const maxAttempts = def.executionPolicy.maxFeatureAttempts;
  const maxRounds = def.executionPolicy.maxValidationRounds;
  const concurrency = def.executionPolicy.concurrency;

  for (const milestone of sortedMilestones) {
    if (isMilestoneValidationPassed(milestone.id, snapshot)) continue;

    const milestoneFeatures = def.features.filter((f) => f.milestoneId === milestone.id);

    // Validation and orchestrator invocations are exclusive — block the entire milestone.
    const exclusiveActive = snapshot.activeInvocations.filter(
      (inv) => (inv.type === 'validation' || inv.type === 'orchestrator') && inv.milestoneId === milestone.id,
    );
    if (exclusiveActive.length > 0) return null;

    const allFeaturesComplete = milestoneFeatures.every((f) => isFeatureComplete(f.id, snapshot));

    if (!allFeaturesComplete) {
      // Count in-flight feature invocations against the concurrency limit.
      const runningCount = snapshot.featureAttempts.filter(
        (a) => milestoneFeatures.some((f) => f.id === a.featureId) && a.status === 'running',
      ).length;

      if (runningCount >= concurrency) return null;

      const completedIds = new Set(
        milestoneFeatures.filter((f) => isFeatureComplete(f.id, snapshot)).map((f) => f.id),
      );

      const pending = milestoneFeatures.filter((f) => {
        if (isFeatureComplete(f.id, snapshot)) return false;
        if (isFeatureExhausted(f.id, snapshot, maxAttempts)) return false;
        if (isFeatureRunning(f.id, snapshot)) return false;
        const deps = def.featureDependencies.filter((d) => d.featureId === f.id);
        return deps.every((d) => completedIds.has(d.dependsOnId));
      });

      if (pending.length > 0) {
        return {
          type: 'ImplementFeature',
          featureId: pending[0]!.id,
          invocationId: crypto.randomUUID(),
          milestoneId: milestone.id,
        };
      }

      // No pending features — wait if any are still running.
      const anyRunning = milestoneFeatures.some((f) => isFeatureRunning(f.id, snapshot));
      if (anyRunning) return null;

      if (milestoneFeatures.some((f) => isFeatureExhausted(f.id, snapshot, maxAttempts))) {
        return { type: 'BlockMission', reason: `Feature attempt limit exhausted in milestone ${milestone.id}` };
      }

      return { type: 'BlockMission', reason: `No runnable features — possible dependency deadlock in milestone ${milestone.id}` };
    }

    // All planned features complete — check validation.
    const rounds = snapshot.validationRounds
      .filter((r) => r.milestoneId === milestone.id)
      .sort((a, b) => a.roundNumber - b.roundNumber);

    const lastRound = rounds[rounds.length - 1] ?? null;

    if (lastRound?.status === 'running') return null;

    if (!lastRound) {
      return {
        type: 'ValidateMilestone',
        milestoneId: milestone.id,
        invocationId: crypto.randomUUID(),
        roundNumber: 1,
      };
    }

    if (lastRound.status === 'failed') {
      const findings: ValidationFinding[] = lastRound.handoff?.findings ?? [];

      if (findings.length > 0) {
        const orchDecision = snapshot.orchestratorDecisions.find(
          (d) => d.milestoneId === milestone.id && d.validationRound === lastRound.roundNumber,
        );

        if (!orchDecision) {
          return {
            type: 'RequestOrchestratorRepair',
            milestoneId: milestone.id,
            invocationId: crypto.randomUUID(),
            findings,
          };
        }

        if (!orchDecision.decision.safeToRepair) {
          return {
            type: 'BlockMission',
            reason: `Orchestrator determined no safe bounded repair for milestone ${milestone.id}: ${orchDecision.decision.explanation ?? ''}`,
          };
        }

        // Orchestrator approved repairs — execute them before revalidating.
        const repairFeatures = def.features.filter((f) => f.kind === 'repair' && f.milestoneId === milestone.id);
        const repairsAllComplete = repairFeatures.length === 0 || repairFeatures.every((f) => isFeatureComplete(f.id, snapshot));

        if (!repairsAllComplete) {
          const repairRunning = snapshot.featureAttempts.filter(
            (a) => repairFeatures.some((f) => f.id === a.featureId) && a.status === 'running',
          ).length;

          if (repairRunning < concurrency) {
            const completedRepairIds = new Set(repairFeatures.filter((f) => isFeatureComplete(f.id, snapshot)).map((f) => f.id));
            const pendingRepairs = repairFeatures.filter((f) => {
              if (isFeatureComplete(f.id, snapshot)) return false;
              if (isFeatureExhausted(f.id, snapshot, maxAttempts)) return false;
              if (isFeatureRunning(f.id, snapshot)) return false;
              const deps = def.featureDependencies.filter((d) => d.featureId === f.id);
              return deps.every((d) => completedRepairIds.has(d.dependsOnId));
            });

            if (pendingRepairs.length > 0) {
              return {
                type: 'ImplementFeature',
                featureId: pendingRepairs[0]!.id,
                invocationId: crypto.randomUUID(),
                milestoneId: milestone.id,
              };
            }
          }

          if (repairFeatures.some((f) => isFeatureRunning(f.id, snapshot))) return null;

          if (repairFeatures.some((f) => isFeatureExhausted(f.id, snapshot, maxAttempts))) {
            return { type: 'BlockMission', reason: `Repair feature attempt limit exhausted in milestone ${milestone.id}` };
          }
        }
      }

      if (rounds.length >= maxRounds) {
        return { type: 'BlockMission', reason: `Validation round limit exhausted for milestone ${milestone.id}` };
      }

      return {
        type: 'ValidateMilestone',
        milestoneId: milestone.id,
        invocationId: crypto.randomUUID(),
        roundNumber: lastRound.roundNumber + 1,
      };
    }

    if (lastRound.status === 'blocked') {
      return { type: 'BlockMission', reason: `Validation blocked for milestone ${milestone.id}` };
    }
  }

  return { type: 'CompleteMission' };
}

export function isFeatureComplete(featureId: string, snapshot: MissionSnapshot): boolean {
  return snapshot.featureAttempts.some((a) => a.featureId === featureId && a.status === 'completed');
}

export function isMilestoneValidationPassed(milestoneId: string, snapshot: MissionSnapshot): boolean {
  return snapshot.validationRounds.some((r) => r.milestoneId === milestoneId && r.status === 'passed');
}

function isFeatureRunning(featureId: string, snapshot: MissionSnapshot): boolean {
  return snapshot.featureAttempts.some((a) => a.featureId === featureId && a.status === 'running');
}

function isFeatureExhausted(featureId: string, snapshot: MissionSnapshot, maxAttempts: number): boolean {
  if (isFeatureComplete(featureId, snapshot)) return false;
  const terminalAttempts = snapshot.featureAttempts.filter(
    (a) => a.featureId === featureId && (a.status === 'failed' || a.status === 'blocked'),
  );
  return terminalAttempts.length >= maxAttempts;
}
