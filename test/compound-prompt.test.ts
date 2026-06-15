import { describe, expect, it } from "vitest";
import { buildCompoundPrompt } from "../src/prompts/compound.js";

describe("compound prompt", () => {
  it("describes the explicit improvement artifacts to write", () => {
    const prompt = buildCompoundPrompt({
      workId: "WORK-123",
      sourcePath: "/tmp/source.md",
      specPath: "/tmp/spec.md",
      planPath: "/tmp/plan.md",
      graphPath: "/tmp/graph.json",
      repoPlansDir: "/tmp/repo-plans",
      resultsDir: "/tmp/results",
      reviewsDir: "/tmp/reviews",
      sharedPlanningPath: "/tmp/shared/planning.md",
      sharedImplementationPath: "/tmp/shared/implementation.md",
      sharedReviewPath: "/tmp/shared/review.md",
      sharedPatternsPath: "/tmp/shared/patterns.md",
      localNotesPath: "/tmp/local/notes.md"
    });

    expect(prompt).toContain("devtask compound activity");
    expect(prompt).toContain("/tmp/shared/planning.md");
    expect(prompt).toContain("/tmp/shared/implementation.md");
    expect(prompt).toContain("/tmp/shared/review.md");
    expect(prompt).toContain("/tmp/shared/patterns.md");
    expect(prompt).toContain("/tmp/local/notes.md");
  });
});
