export type WorkflowEvent =
  | {
      kind: "stage_attempt_started";
      entityId: string;
      attemptId: string;
      workId: string | null;
      taskId: string | null;
      stage: string;
      startedAt: string;
      input?: Record<string, unknown> | null;
    }
  | {
      kind: "stage_attempt_completed";
      entityId: string;
      attemptId: string;
      status: "passed" | "failed" | "blocked" | "cancelled";
      finishedAt: string;
      output?: Record<string, unknown> | null;
      artifactRefs?: string[];
      reason?: string | null;
    }
  | {
      kind: "run_attempt_started";
      entityId: string;
      attemptId: string;
      stageAttemptId: string;
      workId: string | null;
      taskId: string | null;
      stage: string;
      runtime: string;
      agent: string | null;
      startedAt: string;
      supervisorPid?: number | null;
      childPid?: number | null;
      sessionName?: string | null;
      logPath?: string | null;
    }
  | {
      kind: "run_attempt_observed";
      entityId: string;
      attemptId: string;
      observedAt: string;
      supervisorPid?: number | null;
      childPid?: number | null;
      sessionName?: string | null;
      logPath?: string | null;
    }
  | {
      kind: "run_attempt_completed";
      entityId: string;
      attemptId: string;
      status: "completed" | "failed" | "cancelled" | "stale";
      finishedAt: string;
      exitCode?: number | null;
      failureReason?: string | null;
    };

export interface StoredWorkflowEvent {
  sequence: number;
  entityId: string;
  kind: WorkflowEvent["kind"];
  event: WorkflowEvent;
  recordedAt: string;
}
