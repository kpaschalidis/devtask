import { describe, it, expect } from 'vitest';
import { SpecWorkflow } from '../src/spec/spec-workflow.js';
import type { SpecPlanner } from '../src/ports/ports.js';
import type { SpecDocument, ApprovedSpec, WorkerHandoff } from '../src/domain/types.js';
import { InvalidDefinitionError, InvalidHandoffError } from '../src/domain/errors.js';

function makeSpec(overrides: Partial<SpecDocument> = {}): SpecDocument {
  const ts = new Date().toISOString();
  return {
    id: 'spec1',
    goal: 'Build X',
    context: 'some context',
    content: 'Here is the spec content.',
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeMockPlanner(): SpecPlanner {
  return {
    async draftSpec(a) {
      return makeSpec({ id: 'draft1', goal: a.goal, context: a.context });
    },
    async reviseSpec(a) {
      return { ...a.spec, content: `${a.spec.content}\n\nRevision: ${a.instruction}`, updatedAt: new Date().toISOString() };
    },
    async implement(a): Promise<WorkerHandoff> {
      return { invocationId: a.invocationId, featureId: 'spec-impl', status: 'completed', summary: 'Implemented spec', checksPerformed: [], artifactRefs: [], blockerInfo: null, knowledgeUpdates: [] };
    },
  };
}

describe('SpecWorkflow', () => {
  it('draft returns a SpecDocument', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const doc = await workflow.draft({ goal: 'Build X', context: 'ctx' });
    expect(doc.goal).toBe('Build X');
    expect(doc.id).toBe('draft1');
  });

  it('draft throws if planner returns invalid shape', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return { broken: true } as unknown as SpecDocument; },
      async reviseSpec() { throw new Error('no'); },
      async implement() { throw new Error('no'); },
    });
    await expect(workflow.draft({ goal: 'x', context: '' })).rejects.toThrow(InvalidHandoffError);
  });

  it('revise returns updated SpecDocument', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec();
    const revised = await workflow.revise(spec, 'Add section 3');
    expect(revised.content).toContain('Add section 3');
  });

  it('revise throws if planner returns invalid shape', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return makeSpec(); },
      async reviseSpec() { return { bad: true } as unknown as SpecDocument; },
      async implement() { throw new Error('no'); },
    });
    await expect(workflow.revise(makeSpec(), 'change')).rejects.toThrow(InvalidHandoffError);
  });

  it('validate returns valid for non-empty spec', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const result = workflow.validate(makeSpec({ content: 'Some content' }));
    expect(result.valid).toBe(true);
  });

  it('validate returns errors for empty content', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const result = workflow.validate(makeSpec({ content: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validate returns errors for empty goal', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const result = workflow.validate(makeSpec({ goal: '' }));
    expect(result.valid).toBe(false);
  });

  it('approve returns ApprovedSpec with timestamp', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec();
    const approved = workflow.approve(spec);
    expect(approved.spec).toBe(spec);
    expect(approved.approvedAt).toBeTruthy();
  });

  it('approve throws for invalid spec (empty content)', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    expect(() => workflow.approve(makeSpec({ content: '' }))).toThrow(InvalidDefinitionError);
  });

  it('approve throws for invalid spec (empty goal)', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    expect(() => workflow.approve(makeSpec({ goal: '' }))).toThrow(InvalidDefinitionError);
  });

  it('implement calls planner and validates handoff', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const approved: ApprovedSpec = { spec: makeSpec(), approvedAt: new Date().toISOString() };
    const handoff = await workflow.implement(approved);
    expect(handoff.status).toBe('completed');
  });

  it('implement re-validates spec content to prevent forged approval', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const forged: ApprovedSpec = { spec: makeSpec({ content: '' }), approvedAt: new Date().toISOString() };
    await expect(workflow.implement(forged)).rejects.toThrow(InvalidDefinitionError);
  });

  it('implement throws if planner returns invalid handoff', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return makeSpec(); },
      async reviseSpec(a) { return a.spec; },
      async implement() { return { bad: true } as unknown as WorkerHandoff; },
    });
    const approved: ApprovedSpec = { spec: makeSpec(), approvedAt: new Date().toISOString() };
    await expect(workflow.implement(approved)).rejects.toThrow(InvalidHandoffError);
  });
});
