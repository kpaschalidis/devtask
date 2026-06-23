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
    return parsed.data;
  }

  async revise(spec: SpecDocument, instruction: string): Promise<SpecDocument> {
    const invocationId = crypto.randomUUID();
    const raw = await this.planner.reviseSpec({ invocationId, spec, instruction });
    const parsed = SpecDocumentSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidHandoffError(`Planner returned invalid revised spec: ${parsed.error.message}`);
    return parsed.data;
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
    return { spec, approvedAt: new Date().toISOString() };
  }

  async implement(spec: ApprovedSpec): Promise<WorkerHandoff> {
    // Re-validate to prevent forged or stale approvals from bypassing validation.
    const validation = this.validate(spec.spec);
    if (!validation.valid) throw new InvalidDefinitionError(validation.errors);

    const invocationId = crypto.randomUUID();
    const raw = await this.planner.implement({ invocationId, spec });
    const parsed = WorkerHandoffSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidHandoffError(`Planner returned invalid implementation handoff: ${parsed.error.message}`);
    return parsed.data;
  }
}
