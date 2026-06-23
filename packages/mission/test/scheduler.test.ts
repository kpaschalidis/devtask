import { describe, it, expect } from 'vitest';
import { deriveNextAction } from '../src/domain/scheduler.js';
import { SCHEMA_VERSION, type MissionSnapshot, type MissionDefinition } from '../src/domain/types.js';

function ts() { return new Date().toISOString(); }

function makeDef(overrides: Partial<MissionDefinition> = {}): MissionDefinition {
  return {
    id: 'def1',
    goal: 'Build a thing',
    context: '',
    validationContract: {
      assertions: [{ id: 'a1', description: 'Works', milestoneIds: ['m1'] }],
    },
    milestones: [{ id: 'm1', name: 'M1', order: 1 }],
    features: [{ id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'Feature 1' }],
    featureDependencies: [],
    executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 1 },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MissionSnapshot> = {}): MissionSnapshot {
  const t = ts();
  return {
    id: 'sn1',
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    status: 'ready',
    definition: makeDef(),
    approvedDefinitionRevision: 0,
    approvedAt: t,
    featureAttempts: [],
    validationRounds: [],
    orchestratorDecisions: [],
    activeInvocations: [],
    redirects: [],
    pauseReason: null,
    blockReason: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe('deriveNextAction', () => {
  it('returns null for draft status', () => {
    expect(deriveNextAction(makeSnapshot({ status: 'draft' }))).toBeNull();
  });

  it('returns null for paused status', () => {
    expect(deriveNextAction(makeSnapshot({ status: 'paused' }))).toBeNull();
  });

  it('returns null for completed status', () => {
    expect(deriveNextAction(makeSnapshot({ status: 'completed' }))).toBeNull();
  });

  it('returns null when no definition', () => {
    expect(deriveNextAction(makeSnapshot({ definition: null }))).toBeNull();
  });

  it('returns ImplementFeature for ready snapshot with pending feature', () => {
    const action = deriveNextAction(makeSnapshot());
    expect(action?.type).toBe('ImplementFeature');
    if (action?.type === 'ImplementFeature') {
      expect(action.featureId).toBe('f1');
      expect(action.milestoneId).toBe('m1');
    }
  });

  it('returns null when feature is running (at concurrency limit)', () => {
    // Both activeInvocation and featureAttempt are set — consistent with real controller state.
    const snapshot = makeSnapshot({
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: null, status: 'running', handoff: null }],
      activeInvocations: [{ invocationId: 'inv1', type: 'feature', featureId: 'f1', milestoneId: 'm1', startedAt: ts() }],
    });
    expect(deriveNextAction(snapshot)).toBeNull();
  });

  it('returns null when feature attempt is running', () => {
    const snapshot = makeSnapshot({
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: null, status: 'running', handoff: null }],
      activeInvocations: [{ invocationId: 'inv1', type: 'feature', featureId: 'f1', milestoneId: 'm1', startedAt: ts() }],
    });
    expect(deriveNextAction(snapshot)).toBeNull();
  });

  it('returns ValidateMilestone when all features complete and no validation round', () => {
    const snapshot = makeSnapshot({
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('ValidateMilestone');
    if (action?.type === 'ValidateMilestone') {
      expect(action.milestoneId).toBe('m1');
      expect(action.roundNumber).toBe(1);
    }
  });

  it('returns CompleteMission when all milestones pass validation', () => {
    const snapshot = makeSnapshot({
      status: 'running',
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{ invocationId: 'vr1', milestoneId: 'm1', roundNumber: 1, startedAt: ts(), completedAt: ts(), status: 'passed', handoff: null }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('CompleteMission');
  });

  it('returns ImplementFeature for second milestone after first passes', () => {
    const def = makeDef({
      milestones: [
        { id: 'm1', name: 'M1', order: 1 },
        { id: 'm2', name: 'M2', order: 2 },
      ],
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm2', description: 'F2' },
      ],
      validationContract: {
        assertions: [
          { id: 'a1', description: 'M1 works', milestoneIds: ['m1'] },
          { id: 'a2', description: 'M2 works', milestoneIds: ['m2'] },
        ],
      },
    });
    const snapshot = makeSnapshot({
      status: 'running',
      definition: def,
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{ invocationId: 'vr1', milestoneId: 'm1', roundNumber: 1, startedAt: ts(), completedAt: ts(), status: 'passed', handoff: null }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('ImplementFeature');
    if (action?.type === 'ImplementFeature') {
      expect(action.featureId).toBe('f2');
    }
  });

  it('returns RequestOrchestratorRepair when validation failed with findings', () => {
    const snapshot = makeSnapshot({
      status: 'running',
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{
        invocationId: 'vr1',
        milestoneId: 'm1',
        roundNumber: 1,
        startedAt: ts(),
        completedAt: ts(),
        status: 'failed',
        handoff: {
          invocationId: 'vr1',
          milestoneId: 'm1',
          validationRound: 1,
          status: 'failed',
          assertionResults: [{ assertionId: 'a1', passed: false, notes: '' }],
          evidenceRefs: [],
          findings: [{ id: 'fi1', assertionId: 'a1', description: 'Broken', severity: 'critical' }],
          environmentBlockers: [],
        },
      }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('RequestOrchestratorRepair');
    if (action?.type === 'RequestOrchestratorRepair') {
      expect(action.milestoneId).toBe('m1');
      expect(action.findings.length).toBe(1);
    }
  });

  it('returns ImplementFeature for repair feature after orchestrator approved repair', () => {
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'r1', kind: 'repair', milestoneId: 'm1', description: 'R1' },
      ],
    });
    const snapshot = makeSnapshot({
      status: 'running',
      definition: def,
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{
        invocationId: 'vr1',
        milestoneId: 'm1',
        roundNumber: 1,
        startedAt: ts(),
        completedAt: ts(),
        status: 'failed',
        handoff: {
          invocationId: 'vr1',
          milestoneId: 'm1',
          validationRound: 1,
          status: 'failed',
          assertionResults: [],
          evidenceRefs: [],
          findings: [{ id: 'fi1', assertionId: 'a1', description: 'Broken', severity: 'critical' }],
          environmentBlockers: [],
        },
      }],
      orchestratorDecisions: [{
        milestoneId: 'm1',
        validationRound: 1,
        recordedAt: ts(),
        decision: {
          invocationId: 'orch1',
          findingIds: ['fi1'],
          repairFeatures: [{ id: 'r1', milestoneId: 'm1', description: 'R1', dependencies: [] }],
          addressedAssertionIds: ['a1'],
          explanation: null,
          safeToRepair: true,
        },
      }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('ImplementFeature');
    if (action?.type === 'ImplementFeature') {
      expect(action.featureId).toBe('r1');
    }
  });

  it('returns BlockMission when feature attempt limit is exhausted', () => {
    const def = makeDef({ executionPolicy: { maxFeatureAttempts: 1, maxValidationRounds: 4, concurrency: 1 } });
    const snapshot = makeSnapshot({
      status: 'running',
      definition: def,
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'failed', handoff: null }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('BlockMission');
  });

  it('returns BlockMission when validation round limit is exhausted', () => {
    const def = makeDef({ executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 1, concurrency: 1 } });
    const snapshot = makeSnapshot({
      status: 'running',
      definition: def,
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{
        invocationId: 'vr1',
        milestoneId: 'm1',
        roundNumber: 1,
        startedAt: ts(),
        completedAt: ts(),
        status: 'failed',
        handoff: {
          invocationId: 'vr1',
          milestoneId: 'm1',
          validationRound: 1,
          status: 'failed',
          assertionResults: [],
          evidenceRefs: [],
          findings: [],
          environmentBlockers: [],
        },
      }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('BlockMission');
  });

  it('respects feature dependencies: does not dispatch f2 before f1 completes', () => {
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm1', description: 'F2' },
      ],
      featureDependencies: [{ featureId: 'f2', dependsOnId: 'f1' }],
      executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 2 },
    });
    const snapshot = makeSnapshot({ definition: def });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('ImplementFeature');
    if (action?.type === 'ImplementFeature') {
      expect(action.featureId).toBe('f1');
    }
  });

  it('independent feature is claimed while another feature is running (concurrency:2)', () => {
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm1', description: 'F2' },
      ],
      featureDependencies: [],
      validationContract: { assertions: [{ id: 'a1', description: 'Works', milestoneIds: ['m1'] }] },
      executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 2 },
    });
    const snapshot = makeSnapshot({
      definition: def,
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: null, status: 'running', handoff: null }],
      activeInvocations: [{ invocationId: 'inv1', type: 'feature', featureId: 'f1', milestoneId: 'm1', startedAt: ts() }],
    });
    // f1 running, concurrency:2 — should still claim f2.
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('ImplementFeature');
    if (action?.type === 'ImplementFeature') {
      expect(action.featureId).toBe('f2');
    }
  });

  it('exclusive validation invocation blocks the entire milestone', () => {
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm1', description: 'F2' },
      ],
      featureDependencies: [],
      executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 2 },
    });
    const snapshot = makeSnapshot({
      definition: def,
      activeInvocations: [{ invocationId: 'val1', type: 'validation', milestoneId: 'm1', startedAt: ts() }],
    });
    expect(deriveNextAction(snapshot)).toBeNull();
  });

  it('orchestrator active invocation blocks the entire milestone', () => {
    const snapshot = makeSnapshot({
      status: 'running',
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      activeInvocations: [{ invocationId: 'orch1', type: 'orchestrator', milestoneId: 'm1', startedAt: ts() }],
    });
    expect(deriveNextAction(snapshot)).toBeNull();
  });

  it('returns BlockMission when orchestrator says not safe', () => {
    const snapshot = makeSnapshot({
      status: 'running',
      featureAttempts: [{ invocationId: 'inv1', featureId: 'f1', attemptNumber: 1, startedAt: ts(), completedAt: ts(), status: 'completed', handoff: null }],
      validationRounds: [{
        invocationId: 'vr1',
        milestoneId: 'm1',
        roundNumber: 1,
        startedAt: ts(),
        completedAt: ts(),
        status: 'failed',
        handoff: {
          invocationId: 'vr1',
          milestoneId: 'm1',
          validationRound: 1,
          status: 'failed',
          assertionResults: [],
          evidenceRefs: [],
          findings: [{ id: 'fi1', assertionId: 'a1', description: 'Bad', severity: 'critical' }],
          environmentBlockers: [],
        },
      }],
      orchestratorDecisions: [{
        milestoneId: 'm1',
        validationRound: 1,
        recordedAt: ts(),
        decision: {
          invocationId: 'orch1',
          findingIds: ['fi1'],
          repairFeatures: [],
          addressedAssertionIds: [],
          explanation: 'Cannot repair without changing the goal',
          safeToRepair: false,
        },
      }],
    });
    const action = deriveNextAction(snapshot);
    expect(action?.type).toBe('BlockMission');
  });
});
