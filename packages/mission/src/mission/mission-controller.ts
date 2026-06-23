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
  type RecoverInvocationInput,
} from '../domain/types.js';
import { validateMissionDefinition, validateOrchestratorDecision, validateWorkerHandoff, validateValidatorHandoff } from '../domain/validation.js';
import { deriveNextAction } from '../domain/scheduler.js';
import {
  ValidationContractSchema,
  MissionDefinitionSchema,
  OrchestratorRepairDecisionSchema,
  ValidationHandoffSchema,
  WorkerHandoffSchema,
} from '../domain/schemas.js';
import {
  InvalidStateError,
  InvalidHandoffError,
  MissingMissionError,
  InvalidDefinitionError,
  StaleRevisionError,
} from '../domain/errors.js';
import type { MissionStore, MissionEvent, NewMissionEvent } from '../store/store.js';
import type { MissionAgents } from '../ports/ports.js';

const MAX_CLAIM_RETRIES = 3;

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
    // Start definition at version 0; each mutation increments it.
    snapshot.definition = { ...defParsed.data, version: 0 };
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

    // Increment definition version on every successful revision.
    const updatedDef = { ...parsed.data, version: snapshot.definition.version + 1 };
    const updated: MissionSnapshot = { ...snapshot, definition: updatedDef, updatedAt: this.now() };
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
    if (snapshot.status !== 'draft' && snapshot.status !== 'awaiting-approval') {
      throw new InvalidStateError(`Cannot approve mission in status: ${snapshot.status}`);
    }
    if (!snapshot.definition) throw new InvalidStateError('Mission has no definition to approve');

    const validation = validateMissionDefinition(snapshot.definition);
    if (!validation.valid) throw new InvalidDefinitionError(validation.errors.map((e) => e.message));

    const ts = this.now();
    const updated: MissionSnapshot = {
      ...snapshot,
      status: 'ready',
      // Track the definition's own version, not the store revision.
      approvedDefinitionVersion: snapshot.definition.version,
      approvedAt: ts,
      updatedAt: ts,
    };
    return this.store.commit({
      id,
      expectedRevision: snapshot.revision,
      snapshot: updated,
      events: [{ type: 'mission.approved', payload: { definitionVersion: snapshot.definition.version } }],
    });
  }

  async advance(id: string): Promise<AdvanceResult> {
    // CAS retry: reload and re-derive on StaleRevisionError up to MAX_CLAIM_RETRIES times.
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_CLAIM_RETRIES; attempt++) {
      try {
        return await this.advanceOnce(id);
      } catch (err) {
        if (err instanceof StaleRevisionError && attempt < MAX_CLAIM_RETRIES) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async advanceOnce(id: string): Promise<AdvanceResult> {
    let snapshot = this.requireMission(id);

    if (snapshot.status === 'ready' || snapshot.status === 'running') {
      // Reject stale approvals: definition may have changed since last approval.
      if (snapshot.definition && snapshot.approvedDefinitionVersion !== snapshot.definition.version) {
        throw new InvalidStateError(
          `Mission definition version ${snapshot.definition.version} is not approved (last approved: ${snapshot.approvedDefinitionVersion}). Call approve() first.`,
        );
      }
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

      // Atomic claim: commit before invoking the port.
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

      const parsedHandoff = WorkerHandoffSchema.safeParse(rawHandoff);
      if (!parsedHandoff.success) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failAttempt(recovered, action.invocationId, ts),
          events: [{ type: 'feature.attempt.invalid-handoff', payload: { invocationId: action.invocationId, errors: [parsedHandoff.error.message] } }],
        });
        throw new InvalidHandoffError(`Worker handoff invalid: ${parsedHandoff.error.message}`);
      }

      const handoff = parsedHandoff.data;
      const identityErrors = validateWorkerHandoff(
        handoff,
        { invocationId: action.invocationId, featureId: action.featureId },
      );
      if (identityErrors.length > 0) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failAttempt(recovered, action.invocationId, ts),
          events: [{ type: 'feature.attempt.invalid-handoff', payload: { invocationId: action.invocationId, errors: identityErrors } }],
        });
        throw new InvalidHandoffError(`Worker handoff invalid: ${identityErrors.join('; ')}`);
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

      const parsedHandoff = ValidationHandoffSchema.safeParse(rawHandoff);
      if (!parsedHandoff.success) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.invalid-handoff', payload: { invocationId: action.invocationId, errors: [parsedHandoff.error.message] } }],
        });
        throw new InvalidHandoffError(`Validator handoff invalid: ${parsedHandoff.error.message}`);
      }

      const handoff = parsedHandoff.data;
      const identityErrors = validateValidatorHandoff(
        handoff,
        {
          invocationId: action.invocationId,
          milestoneId: action.milestoneId,
          roundNumber: action.roundNumber,
          assertionIds: assertions.map((a) => a.id),
        },
      );
      if (identityErrors.length > 0) {
        const recovered = this.requireMission(id);
        this.store.commit({
          id,
          expectedRevision: recovered.revision,
          snapshot: failValidationRound(recovered, action.invocationId, ts),
          events: [{ type: 'validation.round.invalid-handoff', payload: { invocationId: action.invocationId, errors: identityErrors } }],
        });
        throw new InvalidHandoffError(`Validator handoff invalid: ${identityErrors.join('; ')}`);
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
        // Repair insertion increments the definition version (pre-approved: bounded, milestone-scoped).
        updatedDef = {
          ...updatedDef,
          version: updatedDef.version + 1,
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

      // Repairs are pre-approved because they are constrained and milestone-scoped.
      const finished: MissionSnapshot = {
        ...resultSnapshot,
        definition: updatedDef,
        // Update approvedDefinitionVersion to reflect the repair increment (pre-approved).
        approvedDefinitionVersion: updatedDef.version,
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
      if (snapshot.status === 'awaiting-approval') return { snapshot, actionsExecuted, stoppedReason: 'awaiting-approval' };
      if (snapshot.status === 'blocked') return { snapshot, actionsExecuted, stoppedReason: 'blocked' };
      if (snapshot.status === 'failed') return { snapshot, actionsExecuted, stoppedReason: 'failed' };

      const result = await this.advance(id);

      if (result.action !== null) actionsExecuted += 1;

      const after = result.snapshot;
      if (after.status === 'completed') return { snapshot: after, actionsExecuted, stoppedReason: 'completed' };
      if (after.status === 'paused') return { snapshot: after, actionsExecuted, stoppedReason: 'paused' };
      if (after.status === 'awaiting-approval') return { snapshot: after, actionsExecuted, stoppedReason: 'awaiting-approval' };
      if (after.status === 'blocked') return { snapshot: after, actionsExecuted, stoppedReason: 'blocked' };
      if (after.status === 'failed') return { snapshot: after, actionsExecuted, stoppedReason: 'failed' };

      if (result.action === null) break;
    }

    const snapshot = this.requireMission(id);
    if (snapshot.status === 'completed') return { snapshot, actionsExecuted, stoppedReason: 'completed' };
    if (snapshot.status === 'paused') return { snapshot, actionsExecuted, stoppedReason: 'paused' };
    if (snapshot.status === 'awaiting-approval') return { snapshot, actionsExecuted, stoppedReason: 'awaiting-approval' };
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

    // Redirect rewrites future scheduling, so it must be exclusive.
    if (snapshot.activeInvocations.length > 0) {
      throw new InvalidStateError('Cannot redirect while an invocation is active');
    }

    // Reject if a redirect invocation is already active.
    const activeRedirect = snapshot.activeInvocations.find((inv) => inv.type === 'redirect');
    if (activeRedirect) throw new InvalidStateError('A redirect is already in progress');

    const invocationId = crypto.randomUUID();
    const ts = this.now();

    // Record redirect request and pause to prevent concurrent dispatches.
    const paused: MissionSnapshot = {
      ...snapshot,
      status: 'paused',
      activeInvocations: [...snapshot.activeInvocations, { invocationId, type: 'redirect', startedAt: ts }],
      redirects: [...snapshot.redirects, {
        invocationId,
        instruction,
        requestedAt: ts,
        appliedAt: null,
        previousDefinitionVersion: snapshot.definition.version,
      }],
      updatedAt: ts,
    };
    let current = this.store.commit({
      id,
      expectedRevision: snapshot.revision,
      snapshot: paused,
      events: [{ type: 'mission.redirect.requested', payload: { invocationId, instruction } }],
    });

    let rawDef: unknown;
    try {
      rawDef = await this.agents.orchestrator.reviseDefinition({
        invocationId,
        instruction,
        currentDefinition: snapshot.definition,
        snapshot: current,
      });
    } catch (err) {
      // Remove redirect invocation but leave paused — caller can retry.
      const reloaded = this.requireMission(id);
      this.store.commit({
        id,
        expectedRevision: reloaded.revision,
        snapshot: removeActiveInv(reloaded, invocationId, ts),
        events: [{ type: 'mission.redirect.exception', payload: { invocationId, error: String(err) } }],
      });
      throw err;
    }

    const defParsed = MissionDefinitionSchema.safeParse(rawDef);
    if (!defParsed.success) {
      const reloaded = this.requireMission(id);
      this.store.commit({
        id,
        expectedRevision: reloaded.revision,
        snapshot: removeActiveInv(reloaded, invocationId, ts),
        events: [{ type: 'mission.redirect.invalid', payload: { invocationId, error: defParsed.error.message } }],
      });
      throw new InvalidHandoffError(`Orchestrator returned invalid revised definition: ${defParsed.error.message}`);
    }

    const defValidation = validateMissionDefinition(defParsed.data);
    if (!defValidation.valid) {
      const reloaded = this.requireMission(id);
      this.store.commit({
        id,
        expectedRevision: reloaded.revision,
        snapshot: removeActiveInv(reloaded, invocationId, ts),
        events: [{ type: 'mission.redirect.invalid', payload: { invocationId, errors: defValidation.errors.map((e) => e.message) } }],
      });
      throw new InvalidDefinitionError(defValidation.errors.map((e) => e.message));
    }

    // Increment definition version; clear approval until re-approved.
    const newDefVersion = snapshot.definition.version + 1;
    const revisedDef = { ...defParsed.data, version: newDefVersion };

    const reloaded = this.requireMission(id);
    const redirectIdx = reloaded.redirects.findIndex((r) => r.invocationId === invocationId);
    const updatedRedirects = reloaded.redirects.map((r, i) =>
      i === redirectIdx ? { ...r, appliedAt: this.now() } : r,
    );
    const updated: MissionSnapshot = {
      ...reloaded,
      definition: revisedDef,
      status: 'awaiting-approval',
      approvedDefinitionVersion: null,
      approvedAt: null,
      activeInvocations: reloaded.activeInvocations.filter((inv) => inv.invocationId !== invocationId),
      redirects: updatedRedirects,
      updatedAt: this.now(),
    };
    return this.store.commit({
      id,
      expectedRevision: reloaded.revision,
      snapshot: updated,
      events: [{ type: 'mission.redirect.applied', payload: { invocationId, newDefinitionVersion: newDefVersion } }],
    });
  }

  /**
   * Recover an orphaned active invocation after process interruption.
   * Accepts the existing result, or marks the attempt/round failed or blocked,
   * using the original invocationId.
   * Never creates a new invocation.
   */
  recoverInvocation(input: RecoverInvocationInput): MissionSnapshot {
    const snapshot = this.requireMission(input.missionId);
    const active = snapshot.activeInvocations.find((inv) => inv.invocationId === input.invocationId);
    if (!active) {
      const knownTerminal = snapshot.featureAttempts.some((a) => a.invocationId === input.invocationId && a.status !== 'running')
        || snapshot.validationRounds.some((r) => r.invocationId === input.invocationId && r.status !== 'running')
        || snapshot.redirects.some((r) => r.invocationId === input.invocationId && r.appliedAt !== null)
        || snapshot.orchestratorDecisions.some((r) => r.decision.invocationId === input.invocationId);
      if (knownTerminal) return snapshot;
      throw new InvalidStateError(`No active invocation ${input.invocationId} in mission ${input.missionId}`);
    }

    const ts = this.now();
    let updated: MissionSnapshot;

    if (active.type === 'feature') {
      const result = recoverFeatureAttempt(snapshot, input, ts);
      updated = {
        ...snapshot,
        featureAttempts: result.attempts,
        activeInvocations: snapshot.activeInvocations.filter((inv) => inv.invocationId !== input.invocationId),
        updatedAt: ts,
      };
    } else if (active.type === 'validation') {
      const result = recoverValidationRound(snapshot, input, ts);
      updated = {
        ...snapshot,
        validationRounds: result.rounds,
        activeInvocations: snapshot.activeInvocations.filter((inv) => inv.invocationId !== input.invocationId),
        updatedAt: ts,
      };
    } else {
      // orchestrator or redirect: just remove the active invocation.
      updated = removeActiveInv(snapshot, input.invocationId, ts);
    }

    return this.store.commit({
      id: input.missionId,
      expectedRevision: snapshot.revision,
      snapshot: updated,
      events: [{ type: 'invocation.recovered', payload: { invocationId: input.invocationId, type: active.type, outcome: input.outcome, reason: input.reason ?? null } }],
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
      approvedDefinitionVersion: null,
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

function recoverFeatureAttempt(
  snapshot: MissionSnapshot,
  input: RecoverInvocationInput,
  ts: string,
): { attempts: MissionSnapshot['featureAttempts'] } {
  const attempt = snapshot.featureAttempts.find((a) => a.invocationId === input.invocationId);
  if (!attempt) throw new InvalidStateError(`No feature attempt for invocation ${input.invocationId}`);
  if (input.outcome === 'passed') throw new InvalidStateError('Feature recovery outcome cannot be passed');

  if (input.handoff !== undefined) {
    const parsed = WorkerHandoffSchema.safeParse(input.handoff);
    if (!parsed.success) throw new InvalidHandoffError(`Recovered worker handoff invalid: ${parsed.error.message}`);
    const errors = validateWorkerHandoff(parsed.data, { invocationId: input.invocationId, featureId: attempt.featureId });
    if (errors.length > 0) throw new InvalidHandoffError(`Recovered worker handoff invalid: ${errors.join('; ')}`);
    return {
      attempts: snapshot.featureAttempts.map((a) =>
        a.invocationId === input.invocationId ? { ...a, status: parsed.data.status, completedAt: ts, handoff: parsed.data } : a,
      ),
    };
  }

  if (input.outcome === 'completed') {
    throw new InvalidHandoffError('Feature recovery outcome completed requires a worker handoff');
  }

  return {
    attempts: snapshot.featureAttempts.map((a) =>
      a.invocationId === input.invocationId ? { ...a, status: input.outcome === 'blocked' ? 'blocked' : 'failed', completedAt: ts } : a,
    ),
  };
}

function recoverValidationRound(
  snapshot: MissionSnapshot,
  input: RecoverInvocationInput,
  ts: string,
): { rounds: MissionSnapshot['validationRounds'] } {
  const round = snapshot.validationRounds.find((r) => r.invocationId === input.invocationId);
  if (!round) throw new InvalidStateError(`No validation round for invocation ${input.invocationId}`);
  if (input.outcome === 'completed') throw new InvalidStateError('Validation recovery outcome cannot be completed');

  if (input.handoff !== undefined) {
    const parsed = ValidationHandoffSchema.safeParse(input.handoff);
    if (!parsed.success) throw new InvalidHandoffError(`Recovered validator handoff invalid: ${parsed.error.message}`);
    const assertionIds = snapshot.definition?.validationContract.assertions
      .filter((a) => a.milestoneIds.includes(round.milestoneId))
      .map((a) => a.id) ?? [];
    const errors = validateValidatorHandoff(parsed.data, {
      invocationId: input.invocationId,
      milestoneId: round.milestoneId,
      roundNumber: round.roundNumber,
      assertionIds,
    });
    if (errors.length > 0) throw new InvalidHandoffError(`Recovered validator handoff invalid: ${errors.join('; ')}`);
    return {
      rounds: snapshot.validationRounds.map((r) =>
        r.invocationId === input.invocationId ? { ...r, status: parsed.data.status, completedAt: ts, handoff: parsed.data } : r,
      ),
    };
  }

  if (input.outcome === 'passed') {
    throw new InvalidHandoffError('Validation recovery outcome passed requires a validator handoff');
  }

  return {
    rounds: snapshot.validationRounds.map((r) =>
      r.invocationId === input.invocationId ? { ...r, status: input.outcome === 'blocked' ? 'blocked' : 'failed', completedAt: ts } : r,
    ),
  };
}
