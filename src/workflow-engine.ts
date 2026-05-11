export const DEFAULT_DEV_WORKFLOW_STAGES = ["plan", "run", "check", "fix", "review", "approve", "commit", "pr", "ci"] as const;

export type WorkflowStageId = (typeof DEFAULT_DEV_WORKFLOW_STAGES)[number];
export type WorkflowUnitStatus = "passed" | "failed" | "skipped" | "started";

export interface WorkflowStageDefinition {
  id: WorkflowStageId;
  dependsOn: WorkflowStageId[];
  parallel: boolean;
  requiresHuman: boolean;
}

export interface WorkflowDefinition {
  id: string;
  stages: WorkflowStageDefinition[];
}

export interface WorkflowUnit {
  target: string;
  taskId: string;
  repoPath: string;
}

export interface WorkflowUnitResult {
  unit: WorkflowUnit;
  status: WorkflowUnitStatus;
  detail: string;
}

export interface WorkflowStageResult {
  workflowId: string;
  stage: WorkflowStageId;
  results: WorkflowUnitResult[];
}

export interface WorkflowStageExecutor {
  stage: WorkflowStageId;
  run(unit: WorkflowUnit): Promise<Omit<WorkflowUnitResult, "unit">>;
}

export const DEFAULT_DEV_WORKFLOW: WorkflowDefinition = {
  id: "default-dev",
  stages: [
    { id: "plan", dependsOn: [], parallel: true, requiresHuman: false },
    { id: "run", dependsOn: ["plan"], parallel: true, requiresHuman: false },
    { id: "check", dependsOn: ["run"], parallel: true, requiresHuman: false },
    { id: "fix", dependsOn: ["check"], parallel: true, requiresHuman: false },
    { id: "review", dependsOn: ["check"], parallel: true, requiresHuman: false },
    { id: "approve", dependsOn: ["review"], parallel: true, requiresHuman: true },
    { id: "commit", dependsOn: ["approve"], parallel: true, requiresHuman: false },
    { id: "pr", dependsOn: ["commit"], parallel: true, requiresHuman: false },
    { id: "ci", dependsOn: ["pr"], parallel: true, requiresHuman: false }
  ]
};

export async function runWorkflowStage(
  workflow: WorkflowDefinition,
  units: WorkflowUnit[],
  executor: WorkflowStageExecutor
): Promise<WorkflowStageResult> {
  const definition = workflow.stages.find((stage) => stage.id === executor.stage);
  if (!definition) {
    throw new Error(`Workflow ${workflow.id} does not define stage ${executor.stage}`);
  }

  const results = definition.parallel
    ? await Promise.all(units.map((unit) => runUnit(unit, executor)))
    : await runSequential(units, executor);

  return {
    workflowId: workflow.id,
    stage: executor.stage,
    results
  };
}

export function workflowStageFailed(result: WorkflowStageResult): boolean {
  return result.results.some((unit) => unit.status === "failed");
}

async function runSequential(units: WorkflowUnit[], executor: WorkflowStageExecutor): Promise<WorkflowUnitResult[]> {
  const results: WorkflowUnitResult[] = [];
  for (const unit of units) {
    results.push(await runUnit(unit, executor));
  }
  return results;
}

async function runUnit(unit: WorkflowUnit, executor: WorkflowStageExecutor): Promise<WorkflowUnitResult> {
  try {
    return {
      unit,
      ...(await executor.run(unit))
    };
  } catch (error) {
    return {
      unit,
      status: "failed",
      detail: error instanceof Error ? error.message.split("\n")[0] : String(error)
    };
  }
}
