import crypto from 'node:crypto';
import {
  SCHEMA_VERSION,
  type MissionSnapshot,
  type CreateMissionInput,
  type MissionDefinitionValidation,
  type AdvanceResult,
  type RunOptions,
  type RunResult,
  type Feature,
  type FeatureDependency,
  type OrchestratorRoundRecord,
  type ActiveInvocation,
} from '../domain/types.js';
import { validateMissionDefinition, validateOrchestratorDecision } from '../domain/validation.js';
import { deriveNextAction } from '../domain/scheduler.js';
import {
  ValidationContractSchema,
  MissionDefinitionSchema,
  WorkerHandoffSchema,
  ValidationHandoffSchema,
  OrchestratorRepairDecisionSchema,
} from '../domain/schemas.js';
import {
  InvalidStateError,
  InvalidHandoffError,
  MissingMissionError,
  InvalidDefinitionError,
} from '../domain/errors.js';
import type { MissionStore, MissionEvent, NewMissionEvent } from '../store/store.js';
import type { MissionAgents } from '../ports/ports.js';

export class MissionController {
  constructor(
    private readonly store: MissionStore,
    private readonly agents: MissionAgents,
  ) {}

  async createDraft(input: CreateMissionInput): Promise<MissionSnapshot> {
    // Step 1: Create the validation contract first.
    const contractInvId = crypto.randomUUID();
    const rawContract = await this.agents.planner.createValidationContract({
      invocationId: contractInvId,
      goal: input.goal,
      context: input.context,
    });
    const contractParsed = ValidationContractSchema.safeParse(rawContract);
    if (!contractParsed.success) {
      throw new InvalidHandoffError(`Planner returned invalid validation contract: ${contractParsed.error.message}`);
    }

    // Step 2: Decompose into milestones and features using the pre-created contract.
    const planInvId = crypto.randomUUID();
    const rawDef = await this.agents.planner.planMission({
      invocationId: planInvId,
      goal: input.goal,
      context: input.context,
      validationContract: contractParsed.data,
    });
    const defParsed = MissionDefinitionSchema.safeParse(rawDef);
    if (!defParsed.success) {
      throw new InvalidHandoffError(`Planner returned invalid mission definition: ${defParsed.error.message}`);
    }

    const id = crypto.randomUUID();
    const snapshot = this.emptySnapshot(id);
    snapshot.definition = defParsed.data;
    snapshot.updatedAt = this.now();
    return this.store.create(snapshot, [{ type: 'mission.draft.created', payload: { contractInvId, planInvId } }]);
  }

  async reviseDraft(id: string, instruction: string): Promise<MissionSnapshot> {
    const snapshot = this.requireMission(id);
    if (snapshot.status !== 'draft') throw new InvalidStateError(`Cannot revise mission in status: ${snapshot.status}`);
    if (!snapshot.definition) throw new InvalidStateError('Mission has no definition to revise');

    const invocationId = crypto.randomUUID();
    const rawDef = await this.agents.planner.reviseMission({ invocationId, definition: snapshot.definition, instruction });
    const parsed = MissionDefinitionSchema.safeParse(rawDef);
    if (!parsed.success) {
      throw new InvalidHandoffError(`Planner returned invalid revised definition: ${parsed.error.message}`);
    }

    const updated: MissionSnapshot = { ...snapshot, definition: parsed.data, updatedAt: this.now() };
    return this.store.commit({
      id,
      expectedRevision: snapshot.revision,
      snapshot: updated,
      events: [{ type: 'mission.draft.revised', payload: { invocationId, instruction } }],
    });
  }

  validateDefinition(id: string): MissionDefinitionValidation {
    const snapshot = this.requireMission(id);
    if (!snapshot.definition) return { valid: false, errors: [{ code: 'NO_DEFINITION', message: 'Mission has no definition' }] };
    return validateMissionDefinition(snapshot.definition);
  }

  async approve(id: string): Promise<MissionSnapshot> {
    const snapshot = this.requireMission(id);
    if (snapshot.status !== 'draft') throw new InvalidStateError(`Cannot approve mission in status: ${snapshot.status}`);
    if (!snapshot.definition) throw new InvalidStateError('Mission has no definition to approve');

    const validation = validateMissionDefinition(snapshot.definition);
    if (!validation.valid) throw new InvalidDefinitionError(validation.errors.map((e) => e.message));

    const ts = this.now();
    const updated: MissionSnapshot = {
      ...snapshot,
      status: 'ready',
      approvedDefinitionRevision: snapshot.revision,
      approvedAt: ts,
      updatedAt: ts,
    };
    return this.store.commit({
      id,
      expectedRevision: snapshot.revision,
      snapshot: updated,
      events: [{ type: 'mission.approved', payload: {} }],
    });
  }

  async advance(id: string): Promise<AdvanceResult> {
    let snapshot = this.requireMission(id);

    if (snapshot.approvedDefinitionRevision === null && (snapshot.status === 'ready' || snapshot.status === 'running')) {
      throw new InvalidStateError('Mission has no approved definition revision');
    }

    const action = deriveNextAction(snapshot);
    if (!action) return { action: null, snapshot };

    const ts = this.now();

    if (action.type === 'CompleteMission') {
      const updated: MissionSnapshot = { ...snapshot, status: 'completed', updatedAt: ts };
      const committed = this.store.commit({ id, expectedRevision: snapshot.revision, snapshot: updated, events: [{ type: 'mission.completed', payload: {} }] });
      return { action, snapshot: committed };
    }

    if (action.type === 'BlockMission') {
      const updated: MissionSnapshot = { ...snapshot, status: 'blocked', blockReason: action.reason, updatedAt: ts };
      const committed = this.store.commit({ id, expectedRevision: snapshot.revision, snapshot: updated, events: [{ type: 'mission.blocked', payload: { reason: action.reason } }] });
      return { action, snapshot: committed };
    }

    if (action.type === 'ImplementFeature') {
      const def = snapshot.definition!;
      const feature = def.features.find((f) => f.id === action.featureId)!;
      const milestone = def.milestones.find((m) => m.id === action.milestoneId)!;
      const attemptNumber = snapshot.featureAttempts.filter((a) => a.featureId === action.featureId).length + 1;

      const activeInv: ActiveInvocation = {
        invocationId: action.invocationId,
        type: 'feature',
        featureId: action.featureId,
        milestoneId: action.milestoneId,
        startedAt: ts,
      };

      // Atomic claim: add active invocation and running attempt.
      const claimedSnapshot: MissionSnapshot = {
        ...snapshot,
        status: 'running',
        activeInvocations: [...snapshot.activeInvocations, activeInv],
        featureAttempts: [...snapshot.featureAttempts, {
          invocationId: action.invocationId,
          featureId: action.featureId,
          attemptNumber,
          startedAt: ts,
          completedAt: null,
          status: 'running',
          handoff: null,
        }],
        updatedAt: ts,
      };
      snapshot = this.store.commit({
        id,
        expectedRevision: snapshot.revision,
        snapshot: claimedSnapshot,
        events: [{ type: 'feature.attempt.started', payload: { invocationId: action.invocationId, featureId: action.featureId, attemptNumber } }],
      });

      // Execute port — recover atomically on any failure.
      let rawHandoff: unknown;
      try {
        rawHandoff = await this.agents.worker.implement({ invocationId: action.invocationId, feature, milestone, snapshot });
      } catch (err) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failAttempt(recovered, action.invocationId, ts),
          events: [{ type: 'feature.attempt.exception', payload: { invocationId: action.invocationId, error: String(err) } }],
        });
        throw err;
      }

      // Validate JSON shape.
      const parsed = WorkerHandoffSchema.safeParse(rawHandoff);
      if (!parsed.success) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failAttempt(recovered, action.invocationId, ts),
          events: [{ type: 'feature.attempt.invalid-handoff', payload: { invocationId: action.invocationId, error: parsed.error.message } }],
        });
        throw new InvalidHandoffError(`Worker returned invalid handoff: ${parsed.error.message}`);
      }

      // Validate identity.
      const handoff = parsed.data;
      if (handoff.invocationId !== action.invocationId || handoff.featureId !== action.featureId) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failAttempt(recovered, action.invocationId, ts),
          events: [{ type: 'feature.attempt.identity-mismatch', payload: { invocationId: action.invocationId } }],
        });
        throw new InvalidHandoffError(
          `Worker handoff identity mismatch: expected invocationId=${action.invocationId} featureId=${action.featureId}, got invocationId=${handoff.invocationId} featureId=${handoff.featureId}`,
        );
      }

      const resultSnapshot = this.requireMission(id);
      const updatedAttempts = resultSnapshot.featureAttempts.map((a) =>
        a.invocationId === action.invocationId ? { ...a, status: handoff.status, completedAt: ts, handoff } : a,
      );
      const finished: MissionSnapshot = {
        ...resultSnapshot,
        featureAttempts: updatedAttempts,
        activeInvocations: resultSnapshot.activeInvocations.filter((inv) => inv.invocationId !== action.invocationId),
        updatedAt: ts,
      };
      const committed = this.store.commit({
        id,
        expectedRevision: resultSnapshot.revision,
        snapshot: finished,
        events: [{ type: 'feature.attempt.completed', payload: { invocationId: action.invocationId, status: handoff.status } }],
      });
      return { action, snapshot: committed };
    }

    if (action.type === 'ValidateMilestone') {
      const def = snapshot.definition!;
      const milestone = def.milestones.find((m) => m.id === action.milestoneId)!;
      const assertions = def.validationContract.assertions.filter((a) => a.milestoneIds.includes(action.milestoneId));

      const activeInv: ActiveInvocation = {
        invocationId: action.invocationId,
        type: 'validation',
        milestoneId: action.milestoneId,
        startedAt: ts,
      };

      const claimedSnapshot: MissionSnapshot = {
        ...snapshot,
        status: 'running',
        activeInvocations: [...snapshot.activeInvocations, activeInv],
        validationRounds: [...snapshot.validationRounds, {
          invocationId: action.invocationId,
          milestoneId: action.milestoneId,
          roundNumber: action.roundNumber,
          startedAt: ts,
          completedAt: null,
          status: 'running',
          handoff: null,
        }],
        updatedAt: ts,
      };
      snapshot = this.store.commit({
        id,
        expectedRevision: snapshot.revision,
        snapshot: claimedSnapshot,
        events: [{ type: 'validation.round.started', payload: { invocationId: action.invocationId, milestoneId: action.milestoneId, roundNumber: action.roundNumber } }],
      });

      let rawHandoff: unknown;
      try {
        rawHandoff = await this.agents.validator.validate({ invocationId: action.invocationId, milestone, roundNumber: action.roundNumber, assertions, snapshot });
      } catch (err) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.exception', payload: { invocationId: action.invocationId, error: String(err) } }],
        });
        throw err;
      }

      const parsed = ValidationHandoffSchema.safeParse(rawHandoff);
      if (!parsed.success) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.invalid-handoff', payload: { invocationId: action.invocationId, error: parsed.error.message } }],
        });
        throw new InvalidHandoffError(`Validator returned invalid handoff: ${parsed.error.message}`);
      }

      const handoff = parsed.data;

      // Validate identity.
      if (
        handoff.invocationId !== action.invocationId ||
        handoff.milestoneId !== action.milestoneId ||
        handoff.validationRound !== action.roundNumber
      ) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.identity-mismatch', payload: { invocationId: action.invocationId } }],
        });
        throw new InvalidHandoffError(
          `Validator handoff identity mismatch: expected invocationId=${action.invocationId} milestoneId=${action.milestoneId} round=${action.roundNumber}`,
        );
      }

      // Validate assertion coverage: every applicable assertion must appear exactly once.
      const expectedAssertionIds = new Set(assertions.map((a) => a.id));
      const coveredIds = handoff.assertionResults.map((r) => r.assertionId);
      const coveredSet = new Set(coveredIds);
      const missingAssertions = [...expectedAssertionIds].filter((id) => !coveredSet.has(id));
      const duplicateAssertions = coveredIds.filter((id, i) => coveredIds.indexOf(id) !== i);

      if (missingAssertions.length > 0 || duplicateAssertions.length > 0) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.assertion-coverage-error', payload: { invocationId: action.invocationId, missingAssertions, duplicateAssertions } }],
        });
        throw new InvalidHandoffError(
          `Validator handoff assertion coverage error — missing: [${missingAssertions.join(', ')}] duplicate: [${duplicateAssertions.join(', ')}]`,
        );
      }

      // Validate passed status is consistent.
      if (handoff.status === 'passed') {
        const allPassed = handoff.assertionResults.every((r) => r.passed);
        const hasFindings = handoff.findings.length > 0;
        const hasBlockers = handoff.environmentBlockers.length > 0;
        if (!allPassed || hasFindings || hasBlockers) {
          const recovered = this.requireMission(id);
          this.store.commit({
            id,
            expectedRevision: recovered.revision,
            snapshot: failValidationRound(recovered, action.invocationId, ts),
            events: [{ type: 'validation.round.contradictory-passed', payload: { invocationId: action.invocationId } }],
          });
          throw new InvalidHandoffError('Validator returned status=passed but has failing assertions, findings, or blockers');
        }
      }

      const resultSnapshot = this.requireMission(id);
      const updatedRounds = resultSnapshot.validationRounds.map((r) =>
        r.invocationId === action.invocationId ? { ...r, status: handoff.status, completedAt: ts, handoff } : r,
      );
      const finished: MissionSnapshot = {
        ...resultSnapshot,
        validationRounds: updatedRounds,
        activeInvocations: resultSnapshot.activeInvocations.filter((inv) => inv.invocationId !== action.invocationId),
        updatedAt: ts,
      };
      const committed = this.store.commit({
        id,
        expectedRevision: resultSnapshot.revision,
        snapshot: finished,
        events: [{ type: 'validation.round.completed', payload: { invocationId: action.invocationId, status: handoff.status } }],
      });
      return { action, snapshot: committed };
    }

    if (action.type === 'RequestOrchestratorRepair') {
      const def = snapshot.definition!;
      const milestone = def.milestones.find((m) => m.id === action.milestoneId)!;
      const lastRound = snapshot.validationRounds
        .filter((r) => r.milestoneId === action.milestoneId)
        .sort((a, b) => b.roundNumber - a.roundNumber)[0];
      const validationRound = lastRound?.roundNumber ?? 0;

      const activeInv: ActiveInvocation = {
        invocationId: action.invocationId,
        type: 'orchestrator',
        milestoneId: action.milestoneId,
        startedAt: ts,
      };

      const claimedSnapshot: MissionSnapshot = {
        ...snapshot,
        status: 'running',
        activeInvocations: [...snapshot.activeInvocations, activeInv],
        updatedAt: ts,
      };
      snapshot = this.store.commit({
        id,
        expectedRevision: snapshot.revision,
        snapshot: claimedSnapshot,
        events: [{ type: 'orchestrator.repair.requested', payload: { invocationId: action.invocationId, milestoneId: action.milestoneId } }],
      });

      let rawDecision: unknown;
      try {
        rawDecision = await this.agents.orchestrator.reviewFindings({ invocationId: action.invocationId, milestone, findings: action.findings, snapshot });
      } catch (err) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: removeActiveInv(recovered, action.invocationId, ts),
          events: [{ type: 'orchestrator.repair.exception', payload: { invocationId: action.invocationId, error: String(err) } }],
        });
        throw err;
      }

      const parsed = OrchestratorRepairDecisionSchema.safeParse(rawDecision);
      if (!parsed.success) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: removeActiveInv(recovered, action.invocationId, ts),
          events: [{ type: 'orchestrator.repair.invalid-decision', payload: { invocationId: action.invocationId, error: parsed.error.message } }],
        });
        throw new InvalidHandoffError(`Orchestrator returned invalid decision: ${parsed.error.message}`);
      }

      const decision = parsed.data;
      const resultSnapshot = this.requireMission(id);

      // Semantic validation of the repair decision.
      const semanticErrors = validateOrchestratorDecision(decision, { invocationId: action.invocationId, milestone, findings: action.findings }, resultSnapshot.definition!);
      if (semanticErrors.length > 0) {
        this.store.commit({
          id,
          expectedRevision: resultSnapshot.revision,
          snapshot: removeActiveInv(resultSnapshot, action.invocationId, ts),
          events: [{ type: 'orchestrator.repair.semantic-error', payload: { invocationId: action.invocationId, errors: semanticErrors.map((e) => e.message) } }],
        });
        throw new InvalidHandoffError(`Orchestrator repair decision failed semantic validation: ${semanticErrors.map((e) => e.message).join('; ')}`);
      }

      const record: OrchestratorRoundRecord = { milestoneId: action.milestoneId, validationRound, decision, recordedAt: ts };
      let updatedDef = resultSnapshot.definition!;

      if (decision.safeToRepair && decision.repairFeatures.length > 0) {
        const newFeatures: Feature[] = decision.repairFeatures.map((rf) => ({
          id: rf.id,
          kind: 'repair' as const,
          milestoneId: rf.milestoneId,
          description: rf.description,
        }));
        const newDeps: FeatureDependency[] = decision.repairFeatures.flatMap((rf) =>
          rf.dependencies.map((depId) => ({ featureId: rf.id, dependsOnId: depId })),
        );
        updatedDef = {
          ...updatedDef,
          features: [...updatedDef.features, ...newFeatures],
          featureDependencies: [...updatedDef.featureDependencies, ...newDeps],
        };
      }

      const events: NewMissionEvent[] = [{ type: 'orchestrator.repair.decided', payload: { invocationId: action.invocationId, safeToRepair: decision.safeToRepair, repairCount: decision.repairFeatures.length } }];

      if (!decision.safeToRepair) {
        const blocked: MissionSnapshot = {
          ...resultSnapshot,
          definition: updatedDef,
          orchestratorDecisions: [...resultSnapshot.orchestratorDecisions, record],
          activeInvocations: resultSnapshot.activeInvocations.filter((inv) => inv.invocationId !== action.invocationId),
          status: 'blocked',
          blockReason: decision.explanation ?? 'Orchestrator determined no safe repair',
          updatedAt: ts,
        };
        const committed = this.store.commit({ id, expectedRevision: resultSnapshot.revision, snapshot: blocked, events: [...events, { type: 'mission.blocked', payload: { reason: blocked.blockReason } }] });
        return { action, snapshot: committed };
      }

      const finished: MissionSnapshot = {
        ...resultSnapshot,
        definition: updatedDef,
        orchestratorDecisions: [...resultSnapshot.orchestratorDecisions, record],
        activeInvocations: resultSnapshot.activeInvocations.filter((inv) => inv.invocationId !== action.invocationId),
        updatedAt: ts,
      };
      const committed = this.store.commit({ id, expectedRevision: resultSnapshot.revision, snapshot: finished, events });
      return { action, snapshot: committed };
    }

    return { action: null, snapshot };
  }

  async run(id: string, options?: RunOptions): Promise<RunResult> {
    const maxActions = options?.maxActions ?? 100;
    let actionsExecuted = 0;

    while (actionsExecuted < maxActions) {
      const snapshot = this.requireMission(id);

      if (snapshot.status === 'completed') return { snapshot, actionsExecuted, stoppedReason: 'completed' };
      if (snapshot.status === 'paused') return { snapshot, actionsExecuted, stoppedReason: 'paused' };
      if (snapshot.status === 'blocked') return { snapshot, actionsExecuted, stoppedReason: 'blocked' };
      if (snapshot.status === 'failed') return { snapshot, actionsExecuted, stoppedReason: 'failed' };

      const result = await this.advance(id);

      if (result.action !== null) actionsExecuted += 1;

      const after = result.snapshot;
      if (after.status === 'completed') return { snapshot: after, actionsExecuted, stoppedReason: 'completed' };
      if (after.status === 'paused') return { snapshot: after, actionsExecuted, stoppedReason: 'paused' };
      if (after.status === 'blocked') return { snapshot: after, actionsExecuted, stoppedReason: 'blocked' };
      if (after.status === 'failed') return { snapshot: after, actionsExecuted, stoppedReason: 'failed' };

      if (result.action === null) break;
    }

    const snapshot = this.requireMission(id);
    if (snapshot.status === 'completed') return { snapshot, actionsExecuted, stoppedReason: 'completed' };
    if (snapshot.status === 'paused') return { snapshot, actionsExecuted, stoppedReason: 'paused' };
    if (snapshot.status === 'blocked') return { snapshot, actionsExecuted, stoppedReason: 'blocked' };
    return { snapshot, actionsExecuted, stoppedReason: 'limit' };
  }

  pause(id: string, reason?: string): MissionSnapshot {
    const snapshot = this.requireMission(id);
    if (snapshot.status !== 'running' && snapshot.status !== 'ready') {
      throw new InvalidStateError(`Cannot pause mission in status: ${snapshot.status}`);
    }
    const updated: MissionSnapshot = { ...snapshot, status: 'paused', pauseReason: reason ?? null, updatedAt: this.now() };
    return this.store.commit({ id, expectedRevision: snapshot.revision, snapshot: updated, events: [{ type: 'mission.paused', payload: { reason: reason ?? null } }] });
  }

  resume(id: string): MissionSnapshot {
    const snapshot = this.requireMission(id);
    if (snapshot.status !== 'paused') throw new InvalidStateError(`Cannot resume mission in status: ${snapshot.status}`);
    const updated: MissionSnapshot = { ...snapshot, status: 'running', pauseReason: null, updatedAt: this.now() };
    return this.store.commit({ id, expectedRevision: snapshot.revision, snapshot: updated, events: [{ type: 'mission.resumed', payload: {} }] });
  }

  async redirect(id: string, instruction: string): Promise<MissionSnapshot> {
    const snapshot = this.requireMission(id);
    if (snapshot.status === 'completed' || snapshot.status === 'failed') {
      throw new InvalidStateError(`Cannot redirect mission in status: ${snapshot.status}`);
    }
    if (!snapshot.definition) throw new InvalidStateError('Mission has no definition to redirect');

    const invocationId = crypto.randomUUID();
    const ts = this.now();

    // Record redirect request and pause to prevent concurrent dispatches.
    const paused: MissionSnapshot = {
      ...snapshot,
      status: 'paused',
      redirects: [...snapshot.redirects, {
        invocationId,
        instruction,
        requestedAt: ts,
        appliedAt: null,
        previousDefinitionRevision: snapshot.revision,
      }],
      updatedAt: ts,
    };
    let current = this.store.commit({
      id,
      expectedRevision: snapshot.revision,
      snapshot: paused,
      events: [{ type: 'mission.redirect.requested', payload: { invocationId, instruction } }],
    });

    // Invoke orchestrator to produce a revised definition.
    let rawDef: unknown;
    try {
      rawDef = await this.agents.orchestrator.reviseDefinition({
        invocationId,
        instruction,
        currentDefinition: snapshot.definition,
        snapshot: current,
      });
    } catch (err) {
      // Leave paused — caller can retry or handle.
      throw err;
    }

    const defParsed = MissionDefinitionSchema.safeParse(rawDef);
    if (!defParsed.success) {
      throw new InvalidHandoffError(`Orchestrator returned invalid revised definition: ${defParsed.error.message}`);
    }

    const defValidation = validateMissionDefinition(defParsed.data);
    if (!defValidation.valid) {
      throw new InvalidDefinitionError(defValidation.errors.map((e) => e.message));
    }

    // Store the revised definition; require a fresh approve() before execution resumes.
    const reloaded = this.requireMission(id);
    const redirectIdx = reloaded.redirects.findIndex((r) => r.invocationId === invocationId);
    const updatedRedirects = reloaded.redirects.map((r, i) =>
      i === redirectIdx ? { ...r, appliedAt: this.now() } : r,
    );
    const updated: MissionSnapshot = {
      ...reloaded,
      definition: defParsed.data,
      status: 'draft',
      approvedDefinitionRevision: null,
      approvedAt: null,
      redirects: updatedRedirects,
      updatedAt: this.now(),
    };
    return this.store.commit({
      id,
      expectedRevision: reloaded.revision,
      snapshot: updated,
      events: [{ type: 'mission.redirect.applied', payload: { invocationId } }],
    });
  }

  get(id: string): MissionSnapshot | null {
    return this.store.get(id);
  }

  listEvents(id: string, afterSequence?: number): MissionEvent[] {
    return this.store.listEvents(id, afterSequence);
  }

  private requireMission(id: string): MissionSnapshot {
    const snapshot = this.store.get(id);
    if (!snapshot) throw new MissingMissionError(id);
    return snapshot;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private emptySnapshot(id: string): MissionSnapshot {
    const ts = this.now();
    return {
      id,
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      status: 'draft',
      definition: null,
      approvedDefinitionRevision: null,
      approvedAt: null,
      featureAttempts: [],
      validationRounds: [],
      orchestratorDecisions: [],
      activeInvocations: [],
      redirects: [],
      pauseReason: null,
      blockReason: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }
}

function removeActiveInv(snapshot: MissionSnapshot, invocationId: string, ts: string): MissionSnapshot {
  return {
    ...snapshot,
    activeInvocations: snapshot.activeInvocations.filter((inv) => inv.invocationId !== invocationId),
    updatedAt: ts,
  };
}

function failAttempt(snapshot: MissionSnapshot, invocationId: string, ts: string): MissionSnapshot {
  return {
    ...removeActiveInv(snapshot, invocationId, ts),
    featureAttempts: snapshot.featureAttempts.map((a) =>
      a.invocationId === invocationId ? { ...a, status: 'failed', completedAt: ts } : a,
    ),
  };
}

function failValidationRound(snapshot: MissionSnapshot, invocationId: string, ts: string): MissionSnapshot {
  return {
    ...removeActiveInv(snapshot, invocationId, ts),
    validationRounds: snapshot.validationRounds.map((r) =>
      r.invocationId === invocationId ? { ...r, status: 'failed', completedAt: ts } : r,
    ),
  };
}
