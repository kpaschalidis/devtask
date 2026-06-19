import { loadInstruction } from "../instructions/loader.js";

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
  proposalsPath: string;
}): string {
  return loadInstruction("compound", {
    WORK_ID: context.workId,
    SOURCE_PATH: context.sourcePath,
    SPEC_PATH: context.specPath ?? "-",
    PLAN_PATH: context.planPath ?? "-",
    GRAPH_PATH: context.graphPath ?? "-",
    REPO_PLANS_DIR: context.repoPlansDir,
    RESULTS_DIR: context.resultsDir,
    REVIEWS_DIR: context.reviewsDir,
    SHARED_PLANNING_PATH: context.sharedPlanningPath,
    SHARED_IMPLEMENTATION_PATH: context.sharedImplementationPath,
    SHARED_REVIEW_PATH: context.sharedReviewPath,
    SHARED_PATTERNS_PATH: context.sharedPatternsPath,
    LOCAL_NOTES_PATH: context.localNotesPath,
    PROPOSALS_PATH: context.proposalsPath
  });
}
