import type { StoredWorkflowEvent, WorkflowEvent } from "./events.js";

export interface WorkflowEventStore {
  append(event: WorkflowEvent): StoredWorkflowEvent;
  history(entityId: string): StoredWorkflowEvent[];
  all(): StoredWorkflowEvent[];
}
