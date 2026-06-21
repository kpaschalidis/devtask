import { describe, expect, it } from "vitest";
import { buildCompoundPrompt } from "../src/prompts/compound.js";

describe("compound prompt", () => {
  it("describes the explicit improvement artifacts to write", () => {
    const prompt = buildCompoundPrompt({
      workId: "WORK-123",
      sourcePath: "/tmp/source.md",
      specPath: "/tmp/spec.md",
      contractPath: "/tmp/contract.md",
      planPath: "/tmp/plan.md",
      graphPath: "/tmp/graph.json",
      repoPlansDir: "/tmp/repo-plans",
      resultsDir: "/tmp/results",
      reviewsDir: "/tmp/reviews",
      learningsPath: "/tmp/shared/work/WORK-123/learnings.md"
    });

    expect(prompt).toContain("devtask compound activity");
    expect(prompt).toContain("/tmp/contract.md");
    expect(prompt).toContain("/tmp/results");
    expect(prompt).toContain("/tmp/reviews");
    expect(prompt).toContain("/tmp/shared/work/WORK-123/learnings.md");
    expect(prompt).toContain("historical report, not active knowledge");
    expect(prompt).toContain("Do not write archives, proposals, candidates, JSONL, or local notes.");
    expect(prompt).not.toContain("SHARED_PLANNING_PATH");
    expect(prompt).not.toContain("PROPOSALS_PATH");
  });
});
