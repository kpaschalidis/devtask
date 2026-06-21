import { loadInstruction } from "../instructions/loader.js";

export function buildCompoundPrompt(context: {
  workId: string;
  sourcePath: string;
  specPath: string | null;
  contractPath: string | null;
  planPath: string | null;
  graphPath: string | null;
  repoPlansDir: string;
  resultsDir: string;
  reviewsDir: string;
  learningsPath: string;
}): string {
  return loadInstruction("compound", {
    WORK_ID: context.workId,
    SOURCE_PATH: context.sourcePath,
    SPEC_PATH: context.specPath ?? "-",
    CONTRACT_PATH: context.contractPath ?? "-",
    PLAN_PATH: context.planPath ?? "-",
    GRAPH_PATH: context.graphPath ?? "-",
    REPO_PLANS_DIR: context.repoPlansDir,
    RESULTS_DIR: context.resultsDir,
    REVIEWS_DIR: context.reviewsDir,
    LEARNINGS_PATH: context.learningsPath
  });
}
