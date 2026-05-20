import type { TaskMeta } from "../types.js";
import type { MaterializedWorkTask } from "../work-materializer.js";

export function buildReviewPrompt(
  task: MaterializedWorkTask,
  meta: TaskMeta,
  reviewPath: string,
  resultPath: string,
  context: {
    clean: boolean;
    commits: number;
    changedFiles: string[];
    diffStat: string;
    latestCheck: string | null;
    latestVerify: string | null;
    latestCi: string | null;
  }
): string {
  return [
    `Review repo task ${task.taskId} for work ${task.graphTaskId}.`,
    "",
    "You are in the devtask review activity.",
    "",
    "Role:",
    "- Review the current repository changes.",
    "- Do not modify files, run fixes, or mutate git state.",
    "- Use the deterministic signals as supporting evidence, not as a substitute for reviewing the changes.",
    `- Write markdown findings to: ${reviewPath}.`,
    `- Write JSON review result to: ${resultPath}.`,
    "",
    "Context:",
    `- repo id: ${task.repoId}`,
    `- task id: ${task.taskId}`,
    `- branch: ${task.branch}`,
    `- worktree: ${task.worktreePath}`,
    `- pr url: ${meta.prUrl ?? "-"}`,
    `- worktree clean: ${String(context.clean)}`,
    `- branch commits: ${String(context.commits)}`,
    `- latest check: ${context.latestCheck ?? "-"}`,
    `- latest verify: ${context.latestVerify ?? "-"}`,
    `- latest ci: ${context.latestCi ?? "-"}`,
    "",
    "Changed files:",
    ...(context.changedFiles.length > 0 ? context.changedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Diff stat:",
    context.diffStat || "-",
    "",
    "Review output rules:",
    "- If you find no actionable issues, mark the review as approved.",
    "- If you find issues, mark the review as findings and list them clearly.",
    "- If there is not enough context to review safely, mark the review as blocked.",
    "",
    "JSON format:",
    '{"status":"approved|findings|blocked","summary":"short summary","findings":["finding 1","finding 2"]}'
  ].join("\n");
}
