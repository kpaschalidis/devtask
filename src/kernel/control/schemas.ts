import { z } from 'zod';

export const controlMessageSchema = z.object({
  message: z.string().nullable().optional(),
});

export const controlQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  recommended: z.boolean().optional(),
});

export const controlQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  helpText: z.string().nullable().optional(),
  type: z.enum(['text', 'single_select', 'multi_select']),
  options: z.array(controlQuestionOptionSchema).nullable().optional(),
  allowOther: z.boolean().optional(),
}).refine(
  (q) => {
    if (q.type === 'text') return true;
    const opts = q.options ?? [];
    return opts.length > 0 || q.allowOther === true;
  },
  { message: 'single_select and multi_select questions must have at least one option or allowOther=true' },
);

export const readinessPayloadSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  summary: z.string().min(1),
  scope: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});

export type ControlQuestionOption = z.infer<typeof controlQuestionOptionSchema>;
export type ControlQuestion = z.infer<typeof controlQuestionSchema>;
export type ReadinessPayload = z.infer<typeof readinessPayloadSchema>;
