import { describe, it, expect } from 'vitest';
import { MissionController } from '../src/mission/mission-controller.js';
import { InMemoryMissionStore } from '../src/store/in-memory-store.js';
import type { MissionAgents, MissionPlanner, MissionOrchestrator } from '../src/ports/ports.js';
import type { MissionDefinition, ValidationContract, WorkerHandoff, ValidationHandoff, OrchestratorRepairDecision } from '../src/domain/types.js';
import { InvalidHandoffError, StaleRevisionError } from '../src/domain/errors.js';

const BASE_CONTRACT: ValidationContract = {
  assertions: [{ id: 'a1', description: 'Works', milestoneIds: ['m1'] }],
};

function makeDef(overrides: Partial<MissionDefinition> = {}): MissionDefinition {
  return {
    id: 'def1',
    goal: 'Build a thing',
    context: '',
    validationContract: BASE_CONTRACT,
    milestones: [{ id: 'm1', name: 'M1', order: 1 }],
    features: [{ id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'Feature 1' }],
    featureDependencies: [],
    executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 1 },
    ...overrides,
  };
}

function makePlanner(def: MissionDefinition): MissionPlanner {
  return {
    async createValidationContract() { return def.validationContract; },
    async planMission() { return def; },
    async reviseMission() { return def; },
  };
}

function nullOrchestrator(): MissionOrchestrator {
  return {
    async reviewFindings() { throw new Error('orchestrator not expected'); },
    async reviseDefinition() { throw new Error('orchestrator not expected'); },
  };
}

function workerSucceeds(): MissionAgents['worker'] {
  return {
    async implement(a): Promise<WorkerHandoff> {
      return { invocationId: a.invocationId, featureId: a.feature.id, status: 'completed', summary: 'Done', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] };
    },
  };
}

function workerFails(): MissionAgents['worker'] {
  return {
    async implement(a): Promise<WorkerHandoff> {
      return { invocationId: a.invocationId, featureId: a.feature.id, status: 'failed', summary: 'Failed', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] };
    },
  };
}

function validatorPasses(): MissionAgents['validator'] {
  return {
    async validate(a): Promise<ValidationHandoff> {
      return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'passed', assertionResults: a.assertions.map((as) => ({ assertionId: as.id, passed: true, notes: '' })), evidenceRefs: [], findings: [], environmentBlockers: [] };
    },
  };
}

function validatorFailsThenPasses(): MissionAgents['validator'] {
  let calls = 0;
  return {
    async validate(a): Promise<ValidationHandoff> {
      calls += 1;
      if (calls === 1) {
        return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'failed', assertionResults: [{ assertionId: 'a1', passed: false, notes: '' }], evidenceRefs: [], findings: [{ id: 'fi1', assertionId: 'a1', description: 'Broken', severity: 'critical' }], environmentBlockers: [] };
      }
      return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'passed', assertionResults: [{ assertionId: 'a1', passed: true, notes: '' }], evidenceRefs: [], findings: [], environmentBlockers: [] };
    },
  };
}

function orchestratorApprovesRepair(repairId: string): MissionOrchestrator {
  return {
    async reviewFindings(a): Promise<OrchestratorRepairDecision> {
      return { invocationId: a.invocationId, findingIds: a.findings.map((f) => f.id), repairFeatures: [{ id: repairId, milestoneId: a.milestone.id, description: 'Fix it', dependencies: [] }], addressedAssertionIds: ['a1'], explanation: null, safeToRepair: true };
    },
    async reviseDefinition() { throw new Error('not expected'); },
  };
}

describe('Mission execution', () => {
  it('single feature mission completes end to end', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = { planner: makePlanner(makeDef()), worker: workerSucceeds(), validator: validatorPasses(), orchestrator: nullOrchestrator() };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);
    const result = await ctrl.run(draft.id);
    expect(result.stoppedReason).toBe('completed');
    expect(result.snapshot.status).toBe('completed');
  });

  it('dependency-ordered features execute in declared order', async () => {
    const order: string[] = [];
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm1', description: 'F2' },
      ],
      featureDependencies: [{ featureId: 'f2', dependsOnId: 'f1' }],
      validationContract: { assertions: [{ id: 'a1', description: 'Works', milestoneIds: ['m1'] }] },
    });
    const agents: MissionAgents = {
      planner: makePlanner(def),
      worker: { async implement(a) { order.push(a.feature.id); return { invocationId: a.invocationId, featureId: a.feature.id, status: 'completed', summary: '', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] }; } },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const store = new InMemoryMissionStore();
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    const result = await ctrl.run(draft.id);
    expect(result.stoppedReason).toBe('completed');
    expect(order).toEqual(['f1', 'f2']);
  });

  it('two independent features with concurrency:2 are both claimed', async () => {
    const claimed: string[] = [];
    // Capture the invocationId supplied by the controller so resolvers can echo it back.
    const capturedInvIds: Record<string, string> = {};
    const resolvers: Record<string, (v: WorkerHandoff) => void> = {};
    const workerPromises: Record<string, Promise<WorkerHandoff>> = {
      f1: new Promise<WorkerHandoff>((res) => { resolvers['f1'] = res; }),
      f2: new Promise<WorkerHandoff>((res) => { resolvers['f2'] = res; }),
    };
    const def = makeDef({
      features: [
        { id: 'f1', kind: 'planned', milestoneId: 'm1', description: 'F1' },
        { id: 'f2', kind: 'planned', milestoneId: 'm1', description: 'F2' },
      ],
      featureDependencies: [],
      validationContract: { assertions: [{ id: 'a1', description: 'Works', milestoneIds: ['m1'] }] },
      executionPolicy: { maxFeatureAttempts: 2, maxValidationRounds: 4, concurrency: 2 },
    });
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(def),
      worker: {
        async implement(a) {
          claimed.push(a.feature.id);
          capturedInvIds[a.feature.id] = a.invocationId;
          return workerPromises[a.feature.id]!;
        },
      },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    // Start two concurrent advances — the claim commits are synchronous so adv1 claims f1,
    // then adv2 reads the updated snapshot and claims f2 (concurrency:2 allows both).
    const [adv1, adv2] = [ctrl.advance(draft.id), ctrl.advance(draft.id)];

    // Both advances are now awaiting their worker promises. capturedInvIds is fully populated
    // since the worker mock runs synchronously up to the `return workerPromises[...]`.
    resolvers['f1']!({ invocationId: capturedInvIds['f1']!, featureId: 'f1', status: 'completed', summary: '', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] });
    resolvers['f2']!({ invocationId: capturedInvIds['f2']!, featureId: 'f2', status: 'completed', summary: '', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] });

    const results = await Promise.allSettled([adv1, adv2]);
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBe(2); // both should succeed since claim commits are sequential
    expect(claimed).toEqual(['f1', 'f2']);
    expect(new Set(claimed).size).toBe(2); // no duplicate feature ids
  });

  it('concurrent advance calls do not duplicate claims on same feature', async () => {
    const store = new InMemoryMissionStore();
    const implemented: string[] = [];
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: {
        async implement(a) {
          implemented.push(a.invocationId);
          return { invocationId: a.invocationId, featureId: a.feature.id, status: 'completed', summary: 'Done', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] };
        },
      },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);

    const results = await Promise.allSettled([ctrl.advance(draft.id), ctrl.advance(draft.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // One should succeed claiming; the other may hit StaleRevisionError or return null action.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    if (rejected.length > 0) {
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(StaleRevisionError);
    }
    expect(implemented.length).toBeLessThanOrEqual(1);
  });

  it('worker exception: attempt marked failed, no orphaned active invocation', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: { async implement() { throw new Error('worker exploded'); } },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    await expect(ctrl.advance(draft.id)).rejects.toThrow('worker exploded');

    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
    expect(snapshot.featureAttempts.some((a) => a.status === 'failed')).toBe(true);
  });

  it('validator exception: round marked failed, no orphaned active invocation', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: workerSucceeds(),
      validator: {
        async validate() { throw new Error('validator exploded'); },
      },
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    // Run feature first (succeeds), then advance to validation (throws).
    await ctrl.advance(draft.id); // ImplementFeature
    await expect(ctrl.advance(draft.id)).rejects.toThrow('validator exploded');

    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
    expect(snapshot.validationRounds.some((r) => r.status === 'failed')).toBe(true);
  });

  it('orchestrator exception: active invocation removed, mission recoverable', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: workerSucceeds(),
      validator: {
        async validate(a): Promise<ValidationHandoff> {
          return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'failed', assertionResults: [{ assertionId: 'a1', passed: false, notes: '' }], evidenceRefs: [], findings: [{ id: 'fi1', assertionId: 'a1', description: 'Broken', severity: 'critical' }], environmentBlockers: [] };
        },
      },
      orchestrator: {
        async reviewFindings() { throw new Error('orchestrator exploded'); },
        async reviseDefinition() { throw new Error('not expected'); },
      },
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    await ctrl.advance(draft.id); // ImplementFeature
    await ctrl.advance(draft.id); // ValidateMilestone (fails)
    await expect(ctrl.advance(draft.id)).rejects.toThrow('orchestrator exploded');

    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
  });

  it('malformed worker handoff: attempt marked failed, throws InvalidHandoffError', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: { async implement() { return { broken: true } as unknown as WorkerHandoff; } },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    await expect(ctrl.advance(draft.id)).rejects.toThrow(InvalidHandoffError);
    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
    expect(snapshot.featureAttempts.some((a) => a.status === 'failed')).toBe(true);
  });

  it('handoff identity mismatch: attempt marked failed, throws InvalidHandoffError', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: {
        async implement(a): Promise<WorkerHandoff> {
          return { invocationId: 'wrong-id', featureId: a.feature.id, status: 'completed', summary: '', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] };
        },
      },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);

    await expect(ctrl.advance(draft.id)).rejects.toThrow(InvalidHandoffError);
    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
    expect(snapshot.featureAttempts.some((a) => a.status === 'failed')).toBe(true);
  });

  it('validator assertion coverage mismatch throws InvalidHandoffError', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: workerSucceeds(),
      validator: {
        async validate(a): Promise<ValidationHandoff> {
          return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'passed', assertionResults: [], evidenceRefs: [], findings: [], environmentBlockers: [] };
        },
      },
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    await ctrl.advance(draft.id);
    await expect(ctrl.advance(draft.id)).rejects.toThrow(InvalidHandoffError);
    const snapshot = ctrl.get(draft.id)!;
    expect(snapshot.activeInvocations).toHaveLength(0);
  });

  it('contradictory passed status throws InvalidHandoffError', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: workerSucceeds(),
      validator: {
        async validate(a): Promise<ValidationHandoff> {
          return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'passed', assertionResults: [{ assertionId: 'a1', passed: false, notes: '' }], evidenceRefs: [], findings: [], environmentBlockers: [] };
        },
      },
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    await ctrl.advance(draft.id);
    await expect(ctrl.advance(draft.id)).rejects.toThrow(InvalidHandoffError);
  });

  it('validation failure → orchestrator repair → revalidation → completed', async () => {
    const def = makeDef();
    const agents: MissionAgents = {
      planner: makePlanner(def),
      worker: workerSucceeds(),
      validator: validatorFailsThenPasses(),
      orchestrator: orchestratorApprovesRepair('r1'),
    };
    const store = new InMemoryMissionStore();
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    const result = await ctrl.run(draft.id);
    expect(result.stoppedReason).toBe('completed');
  });

  it('repair features are bounded to the failing milestone', async () => {
    const def = makeDef();
    const agents: MissionAgents = {
      planner: makePlanner(def),
      worker: workerSucceeds(),
      validator: {
        async validate(a): Promise<ValidationHandoff> {
          return { invocationId: a.invocationId, milestoneId: a.milestone.id, validationRound: a.roundNumber, status: 'failed', assertionResults: [{ assertionId: 'a1', passed: false, notes: '' }], evidenceRefs: [], findings: [{ id: 'fi1', assertionId: 'a1', description: 'broken', severity: 'critical' }], environmentBlockers: [] };
        },
      },
      orchestrator: {
        async reviewFindings(a): Promise<OrchestratorRepairDecision> {
          return {
            invocationId: a.invocationId,
            findingIds: a.findings.map((f) => f.id),
            repairFeatures: [{ id: 'r1', milestoneId: 'wrong-milestone', description: 'Fix', dependencies: [] }],
            addressedAssertionIds: ['a1'],
            explanation: null,
            safeToRepair: true,
          };
        },
        async reviseDefinition() { throw new Error('not expected'); },
      },
    };
    const store = new InMemoryMissionStore();
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    await ctrl.advance(draft.id); // ImplementFeature
    await ctrl.advance(draft.id); // ValidateMilestone (fails)
    await expect(ctrl.advance(draft.id)).rejects.toThrow(InvalidHandoffError);
  });

  it('pause stops dispatching', async () => {
    const store = new InMemoryMissionStore();
    let workerCalled = false;
    const agents: MissionAgents = {
      planner: makePlanner(makeDef()),
      worker: { async implement(a) { workerCalled = true; return { invocationId: a.invocationId, featureId: a.feature.id, status: 'completed', summary: '', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] }; } },
      validator: validatorPasses(),
      orchestrator: nullOrchestrator(),
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    const approved = await ctrl.approve(draft.id);
    ctrl.pause(approved.id, 'stopping');
    const result = await ctrl.run(draft.id);
    expect(result.stoppedReason).toBe('paused');
    expect(workerCalled).toBe(false);
  });

  it('feature attempt limit blocks the mission', async () => {
    const def = makeDef({ executionPolicy: { maxFeatureAttempts: 1, maxValidationRounds: 4, concurrency: 1 } });
    const agents: MissionAgents = { planner: makePlanner(def), worker: workerFails(), validator: validatorPasses(), orchestrator: nullOrchestrator() };
    const store = new InMemoryMissionStore();
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    const result = await ctrl.run(draft.id);
    expect(result.stoppedReason).toBe('blocked');
    expect(result.snapshot.status).toBe('blocked');
  });

  it('run respects maxActions limit', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = { planner: makePlanner(makeDef()), worker: workerSucceeds(), validator: validatorPasses(), orchestrator: nullOrchestrator() };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    const result = await ctrl.run(draft.id, { maxActions: 1 });
    expect(result.actionsExecuted).toBeLessThanOrEqual(1);
  });
});
