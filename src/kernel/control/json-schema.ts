export const stringArraySchema = { type: 'array', items: { type: 'string' } };

const controlQuestionOptionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'description', 'recommended'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    description: { type: ['string', 'null'] },
    recommended: { type: 'boolean' },
  },
};

export const controlQuestionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'required', 'helpText', 'type', 'options', 'allowOther'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    required: { type: 'boolean' },
    helpText: { type: ['string', 'null'] },
    type: { type: 'string', enum: ['text', 'single_select', 'multi_select'] },
    options: { type: ['array', 'null'], items: controlQuestionOptionJsonSchema },
    allowOther: { type: 'boolean' },
  },
};

export const readinessJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'prompt', 'summary', 'scope', 'assumptions', 'risks'],
  properties: {
    title: { type: 'string' },
    prompt: { type: 'string' },
    summary: { type: 'string' },
    scope: stringArraySchema,
    assumptions: stringArraySchema,
    risks: stringArraySchema,
  },
};

export const nullableStringSchema = { type: ['string', 'null'] };

export const nullSchema = { type: 'null' };
