// Built-in artifact kinds. Handlers may produce additional kinds.
export const ArtifactKinds = {
  EXECUTION_GRAPH: 'execution-graph',
  PLAN:            'plan',
  CODE_CHANGES:    'code-changes',
  CHECK_RESULT:    'check-result',
  REVIEW:          'review',
  PR_REF:          'pr-ref',
} as const;

export type ArtifactKind = string;

export interface Artifact {
  id: string;
  workId: string;
  taskId: string | null;
  stageAttemptId: string;
  kind: ArtifactKind;
  path: string;
  createdAt: string;
}
