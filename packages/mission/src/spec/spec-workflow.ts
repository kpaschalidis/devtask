import crypto from 'node:crypto';
import type { CreateSpecInput, SpecDocument, SpecValidation, ApprovedSpec, WorkerHandoff } from '../domain/types.js';
import { SpecDocumentSchema, WorkerHandoffSchema } from '../domain/schemas.js';
import { InvalidDefinitionError, InvalidHandoffError } from '../domain/errors.js';
import type { SpecPlanner } from '../ports/ports.js';

export class SpecWorkflow {
  constructor(private readonly planner: SpecPlanner) {}

  async draft(input: CreateSpecInput): Promise<SpecDocument> {
    const invocationId = crypto.randomUUID();
    const raw = await this.planner.draftSpec({ invocationId, goal: input.goal, context: input.context });
    const parsed = SpecDocumentSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidHandoffError(`Planner returned invalid spec document: ${parsed.error.message}`);
    const doc = parsed.data;
    // Version 1 for a fresh draft regardless of what the planner returned.
    return { ...doc, version: 1 };
  }

  async revise(spec: SpecDocument, instruction: string): Promise<SpecDocument> {
    const invocationId = crypto.randomUUID();
    const raw = await this.planner.reviseSpec({ invocationId, spec, instruction });
    const parsed = SpecDocumentSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidHandoffError(`Planner returned invalid revised spec: ${parsed.error.message}`);
    // Revision always increments version.
    return { ...parsed.data, version: spec.version + 1 };
  }

  validate(spec: SpecDocument): SpecValidation {
    const errors: string[] = [];
    if (!spec.content || spec.content.trim().length === 0) {
      errors.push('Spec content must not be empty');
    }
    if (!spec.goal || spec.goal.trim().length === 0) {
      errors.push('Spec must have a non-empty goal');
    }
    return { valid: errors.length === 0, errors };
  }

  approve(spec: SpecDocument): ApprovedSpec {
    const validation = this.validate(spec);
    if (!validation.valid) throw new InvalidDefinitionError(validation.errors);
    const digest = computeSpecDigest(spec);
    return { spec, approvedVersion: spec.version, approvedDigest: digest, approvedAt: new Date().toISOString() };
  }

  async implement(approved: ApprovedSpec): Promise<WorkerHandoff> {
    // Re-validate to prevent forged or stale approvals from bypassing validation.
    const validation = this.validate(approved.spec);
    if (!validation.valid) throw new InvalidDefinitionError(validation.errors);

    // Verify version and digest match — reject mutated or forged approvals.
    if (approved.spec.version !== approved.approvedVersion) {
      throw new InvalidDefinitionError([
        `Spec version mismatch: approved at version ${approved.approvedVersion} but spec is now version ${approved.spec.version}`,
      ]);
    }
    const currentDigest = computeSpecDigest(approved.spec);
    if (currentDigest !== approved.approvedDigest) {
      throw new InvalidDefinitionError([`Spec content has been modified since approval (digest mismatch)`]);
    }

    const invocationId = crypto.randomUUID();
    const raw = await this.planner.implement({ invocationId, spec: approved });
    const parsed = WorkerHandoffSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidHandoffError(`Planner returned invalid implementation handoff: ${parsed.error.message}`);
    if (parsed.data.invocationId !== invocationId) {
      throw new InvalidHandoffError(`Planner returned implementation handoff for invocation ${parsed.data.invocationId}, expected ${invocationId}`);
    }
    if (parsed.data.status === 'blocked' && !parsed.data.blockerInfo) {
      throw new InvalidHandoffError('Planner returned blocked implementation handoff without blockerInfo');
    }
    return parsed.data;
  }
}

function computeSpecDigest(spec: SpecDocument): string {
  const normalized = JSON.stringify({ id: spec.id, version: spec.version, goal: spec.goal, context: spec.context, content: spec.content });
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
