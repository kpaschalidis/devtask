import { describe, it, expect } from 'vitest';
import { SpecWorkflow } from '../src/spec/spec-workflow.js';
import type { SpecPlanner } from '../src/ports/ports.js';
import type { SpecDocument, WorkerHandoff } from '../src/domain/types.js';
import { InvalidDefinitionError, InvalidHandoffError } from '../src/domain/errors.js';

function makeSpec(overrides: Partial<SpecDocument> = {}): SpecDocument {
  const ts = new Date().toISOString();
  return {
    id: 'spec1',
    version: 1,
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
      return makeSpec({ id: 'draft1', version: 1, goal: a.goal, context: a.context });
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
  it('draft returns a SpecDocument with version=1', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const doc = await workflow.draft({ goal: 'Build X', context: 'ctx' });
    expect(doc.goal).toBe('Build X');
    expect(doc.id).toBe('draft1');
    expect(doc.version).toBe(1);
  });

  it('draft throws if planner returns invalid shape', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return { broken: true } as unknown as SpecDocument; },
      async reviseSpec() { throw new Error('no'); },
      async implement() { throw new Error('no'); },
    });
    await expect(workflow.draft({ goal: 'x', context: '' })).rejects.toThrow(InvalidHandoffError);
  });

  it('revise returns updated SpecDocument with incremented version', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec({ version: 1 });
    const revised = await workflow.revise(spec, 'Add section 3');
    expect(revised.content).toContain('Add section 3');
    expect(revised.version).toBe(2);
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

  it('approve returns ApprovedSpec with version and digest', () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec();
    const approved = workflow.approve(spec);
    expect(approved.spec).toBe(spec);
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.approvedVersion).toBe(spec.version);
    expect(approved.approvedDigest).toMatch(/^[0-9a-f]{64}$/);
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
    const approved = workflow.approve(makeSpec());
    const handoff = await workflow.implement(approved);
    expect(handoff.status).toBe('completed');
  });

  it('implement re-validates spec content to prevent forged approval', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    // Construct a forged approval manually, bypassing approve().
    const forgedDirect = { spec: makeSpec({ content: '' }), approvedVersion: 1, approvedDigest: 'fake', approvedAt: new Date().toISOString() };
    await expect(workflow.implement(forgedDirect)).rejects.toThrow(InvalidDefinitionError);
  });

  it('implement rejects forged approval with wrong digest', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec();
    const approved = workflow.approve(spec);
    // Mutate content after approval — digest should no longer match.
    const tampered = { ...approved, spec: { ...spec, content: 'TAMPERED' } };
    await expect(workflow.implement(tampered)).rejects.toThrow(InvalidDefinitionError);
  });

  it('implement rejects stale version approval', async () => {
    const workflow = new SpecWorkflow(makeMockPlanner());
    const spec = makeSpec({ version: 1 });
    const approved = workflow.approve(spec);
    // Bump version to simulate revision after approval.
    const stale = { ...approved, spec: { ...spec, version: 2 } };
    await expect(workflow.implement(stale)).rejects.toThrow(InvalidDefinitionError);
  });

  it('implement throws if planner returns invalid handoff', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return makeSpec(); },
      async reviseSpec(a) { return a.spec; },
      async implement() { return { bad: true } as unknown as WorkerHandoff; },
    });
    const approved = workflow.approve(makeSpec());
    await expect(workflow.implement(approved)).rejects.toThrow(InvalidHandoffError);
  });

  it('implement rejects handoff for a different invocation', async () => {
    const workflow = new SpecWorkflow({
      async draftSpec() { return makeSpec(); },
      async reviseSpec(a) { return a.spec; },
      async implement(): Promise<WorkerHandoff> {
        return {
          invocationId: 'wrong-invocation',
          featureId: 'spec-impl',
          status: 'completed',
          summary: 'Implemented',
          checksPerformed: [],
          artifactRefs: [],
          blockerInfo: null,
          knowledgeUpdates: [],
        };
      },
    });
    const approved = workflow.approve(makeSpec());
    await expect(workflow.implement(approved)).rejects.toThrow(InvalidHandoffError);
  });
});
