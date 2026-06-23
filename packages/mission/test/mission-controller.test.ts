import { describe, it, expect } from 'vitest';
import { MissionController } from '../src/mission/mission-controller.js';
import { InMemoryMissionStore } from '../src/store/in-memory-store.js';
import type { MissionAgents, MissionPlanner, MissionOrchestrator } from '../src/ports/ports.js';
import type { MissionDefinition, ValidationContract } from '../src/domain/types.js';
import { InvalidDefinitionError, InvalidHandoffError, InvalidStateError } from '../src/domain/errors.js';

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

function makeNullOrchestrator(): MissionOrchestrator {
  return {
    async reviewFindings() { throw new Error('not expected'); },
    async reviseDefinition() { throw new Error('not expected'); },
  };
}

function makeNullAgents(): MissionAgents {
  return {
    planner: {
      async createValidationContract() { throw new Error('not expected'); },
      async planMission() { throw new Error('not expected'); },
      async reviseMission() { throw new Error('not expected'); },
    },
    worker: { async implement() { throw new Error('not expected'); } },
    validator: { async validate() { throw new Error('not expected'); } },
    orchestrator: makeNullOrchestrator(),
  };
}

function makePlanner(def: MissionDefinition): MissionPlanner {
  return {
    async createValidationContract() { return BASE_CONTRACT; },
    async planMission(_a) { return def; },
    async reviseMission(_a) { return { ...def, goal: `Revised: ${def.goal}` }; },
  };
}

describe('MissionController', () => {
  it('createDraft calls planner (contract then plan) and stores snapshot', async () => {
    const store = new InMemoryMissionStore();
    const agents = { ...makeNullAgents(), planner: makePlanner(makeDef()) };
    const ctrl = new MissionController(store, agents);
    const snapshot = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    expect(snapshot.status).toBe('draft');
    expect(snapshot.definition?.goal).toBe('Build a thing');
    expect(snapshot.id).toBeTruthy();
  });

  it('createDraft throws on invalid contract from planner', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      ...makeNullAgents(),
      planner: {
        async createValidationContract() { return { not_assertions: [] } as unknown as ValidationContract; },
        async planMission() { throw new Error('not reached'); },
        async reviseMission() { throw new Error('not reached'); },
      },
    };
    const ctrl = new MissionController(store, agents);
    await expect(ctrl.createDraft({ goal: 'x', context: '' })).rejects.toThrow(InvalidHandoffError);
  });

  it('createDraft throws on invalid definition from planner', async () => {
    const store = new InMemoryMissionStore();
    const agents: MissionAgents = {
      ...makeNullAgents(),
      planner: {
        async createValidationContract() { return BASE_CONTRACT; },
        async planMission() { return { not_a_def: true } as unknown as MissionDefinition; },
        async reviseMission() { throw new Error('not reached'); },
      },
    };
    const ctrl = new MissionController(store, agents);
    await expect(ctrl.createDraft({ goal: 'x', context: '' })).rejects.toThrow(InvalidHandoffError);
  });

  it('reviseDraft updates definition', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    const revised = await ctrl.reviseDraft(draft.id, 'Add more detail');
    expect(revised.definition?.goal).toContain('Revised');
    expect(revised.revision).toBe(1);
  });

  it('reviseDraft rejects non-draft missions', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);
    await expect(ctrl.reviseDraft(draft.id, 'change')).rejects.toThrow(InvalidStateError);
  });

  it('validateDefinition returns valid for valid definition', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    const result = ctrl.validateDefinition(draft.id);
    expect(result.valid).toBe(true);
  });

  it('validateDefinition returns errors for missing goal', async () => {
    const store = new InMemoryMissionStore();
    const badDef = makeDef({ goal: '' });
    const agents = { ...makeNullAgents(), planner: makePlanner(badDef) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'irrelevant', context: '' });
    const result = ctrl.validateDefinition(draft.id);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_GOAL')).toBe(true);
  });

  it('approve rejects invalid definitions', async () => {
    const store = new InMemoryMissionStore();
    const badDef = makeDef({ goal: '' });
    const agents = { ...makeNullAgents(), planner: makePlanner(badDef) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'irrelevant', context: '' });
    await expect(ctrl.approve(draft.id)).rejects.toThrow(InvalidDefinitionError);
  });

  it('approve accepts valid definitions and sets status=ready', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    const approved = await ctrl.approve(draft.id);
    expect(approved.status).toBe('ready');
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.approvedDefinitionRevision).not.toBeNull();
  });

  it('approve rejects mission not in draft status', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);
    await expect(ctrl.approve(draft.id)).rejects.toThrow(InvalidStateError);
  });

  it('get returns null for missing mission', () => {
    const store = new InMemoryMissionStore();
    const ctrl = new MissionController(store, makeNullAgents());
    expect(ctrl.get('nonexistent')).toBeNull();
  });

  it('get returns snapshot', async () => {
    const store = new InMemoryMissionStore();
    const agents = { ...makeNullAgents(), planner: makePlanner(makeDef()) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    expect(ctrl.get(draft.id)).not.toBeNull();
  });

  it('listEvents returns events in sequence order', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);
    const events = ctrl.listEvents(draft.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    }
  });

  it('pause sets status to paused', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    const approved = await ctrl.approve(draft.id);
    const paused = ctrl.pause(approved.id, 'taking a break');
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('taking a break');
  });

  it('resume sets status to running', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents = { ...makeNullAgents(), planner: makePlanner(def) };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    const approved = await ctrl.approve(draft.id);
    ctrl.pause(approved.id);
    const resumed = ctrl.resume(approved.id);
    expect(resumed.status).toBe('running');
  });

  it('redirect pauses mission, invokes orchestrator revision, requires new approve', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const revisedDef: MissionDefinition = { ...def, goal: 'Revised goal' };
    const agents: MissionAgents = {
      ...makeNullAgents(),
      planner: makePlanner(def),
      orchestrator: {
        async reviewFindings() { throw new Error('not expected'); },
        async reviseDefinition() { return revisedDef; },
      },
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'Build a thing', context: '' });
    await ctrl.approve(draft.id);

    const redirected = await ctrl.redirect(draft.id, 'change the goal');
    expect(redirected.status).toBe('draft');
    expect(redirected.definition?.goal).toBe('Revised goal');
    expect(redirected.approvedDefinitionRevision).toBeNull();
    expect(redirected.redirects).toHaveLength(1);
    expect(redirected.redirects[0]!.appliedAt).not.toBeNull();
  });

  it('redirect throws if orchestrator returns invalid definition', async () => {
    const store = new InMemoryMissionStore();
    const def = makeDef();
    const agents: MissionAgents = {
      ...makeNullAgents(),
      planner: makePlanner(def),
      orchestrator: {
        async reviewFindings() { throw new Error('not expected'); },
        async reviseDefinition() { return { bad: true } as unknown as MissionDefinition; },
      },
    };
    const ctrl = new MissionController(store, agents);
    const draft = await ctrl.createDraft({ goal: 'x', context: '' });
    await ctrl.approve(draft.id);
    await expect(ctrl.redirect(draft.id, 'change')).rejects.toThrow(InvalidHandoffError);
  });

  it('redirect throws on completed mission', async () => {
    const store = new InMemoryMissionStore();
    const agents = makeNullAgents();
    const ctrl = new MissionController(store, agents);
    // Manually create a completed snapshot
    const snap = store.create({
      id: 'x', schemaVersion: 1, revision: 0, status: 'completed',
      definition: null, approvedDefinitionRevision: null, approvedAt: null,
      featureAttempts: [], validationRounds: [], orchestratorDecisions: [],
      activeInvocations: [], redirects: [], pauseReason: null, blockReason: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, []);
    await expect(ctrl.redirect(snap.id, 'nope')).rejects.toThrow(InvalidStateError);
  });
});
