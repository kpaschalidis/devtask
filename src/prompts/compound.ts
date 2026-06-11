export function buildCompoundPrompt(context: {
  workId: string;
  sourcePath: string;
  specPath: string | null;
  planPath: string | null;
  graphPath: string | null;
  repoPlansDir: string;
  resultsDir: string;
  reviewsDir: string;
  sharedPlanningPath: string;
  sharedImplementationPath: string;
  sharedReviewPath: string;
  sharedPatternsPath: string;
  localNotesPath: string;
}): string {
  return [
    `Compound learnings for work item ${context.workId}.`,
    "",
    "You are in the devtask compound activity.",
    "",
    "Role:",
    "- Read the completed work artifacts and extract reusable guidance.",
    "- Do not edit repositories, git state, or implementation files.",
    "- Write only the explicit improvement artifacts listed below.",
    "",
    "Inputs:",
    `- source artifact: ${context.sourcePath}`,
    `- spec artifact: ${context.specPath ?? "-"}`,
    `- plan artifact: ${context.planPath ?? "-"}`,
    `- graph artifact: ${context.graphPath ?? "-"}`,
    `- repo plans dir: ${context.repoPlansDir}`,
    `- results dir: ${context.resultsDir}`,
    `- reviews dir: ${context.reviewsDir}`,
    "",
    "Write these artifacts:",
    `- planning guidance: ${context.sharedPlanningPath}`,
    `- implementation guidance: ${context.sharedImplementationPath}`,
    `- review guidance: ${context.sharedReviewPath}`,
    `- reusable patterns: ${context.sharedPatternsPath}`,
    `- local notes: ${context.localNotesPath}`,
    "",
    "Writing rules:",
    "- Each file must be concise, specific, and reusable beyond this single work item.",
    "- If there is nothing useful for a file, write a short heading and `- none`.",
    "- Planning guidance should focus on scoping, repo boundaries, and dependency lessons.",
    "- Implementation guidance should focus on execution constraints, common pitfalls, and recovery tactics.",
    "- Review guidance should focus on checks, bug patterns, and reviewer attention points.",
    "- Reusable patterns should capture concrete approaches worth repeating.",
    "- Local notes may include machine-local or tentative reminders that should not be promoted to shared guidance.",
    "",
    "Use Markdown in every output file."
  ].join("\n");
}
