import { describe, expect, it } from "vitest";
import { loadInstruction } from "../src/instructions/loader.js";

describe("loadInstruction", () => {
  it("interpolates placeholder vars in a real instruction file", () => {
    const result = loadInstruction("repo-plan", {
      TASK_ID: "WORK-123",
      TASK_CONTENT: "Build the API",
      STATE_CONTENT: "In progress",
      PLAN_PATH: "/tmp/plan.md",
      MEMORY: ""
    });
    expect(result).toContain("WORK-123");
    expect(result).toContain("Build the API");
    expect(result).not.toContain("{{TASK_ID}}");
    expect(result).not.toContain("{{TASK_CONTENT}}");
    expect(result).not.toContain("{{PLAN_PATH}}");
  });

  it("interpolates all placeholders in the orchestrator instruction", () => {
    const result = loadInstruction("orchestrator", {
      WORK_ID: "WORK-42",
      SOURCE_TYPE: "manual",
      SOURCE_TITLE: "My Feature",
      SOURCE_ARTIFACT: "/tmp/source.md",
      SPEC_PATH: "/tmp/spec.md",
      CONTRACT_PATH: "/tmp/contract.md",
      PLAN_PATH: "/tmp/plan.md",
      GRAPH_PATH: "/tmp/graph.json"
    });
    expect(result).toContain("WORK-42");
    expect(result).not.toContain("{{WORK_ID}}");
    expect(result).not.toContain("{{SOURCE_TYPE}}");
    expect(result).not.toContain("{{PLAN_PATH}}");
    expect(result).not.toContain("{{GRAPH_PATH}}");
  });

  it("instructs the orchestrator to write repo context before starting repo-plan workers", () => {
    const result = loadInstruction("orchestrator", {
      WORK_ID: "WORK-42",
      SOURCE_TYPE: "manual",
      SOURCE_TITLE: "My Feature",
      SOURCE_ARTIFACT: "/tmp/source.md",
      SPEC_PATH: "/tmp/spec.md",
      CONTRACT_PATH: "/tmp/contract.md",
      PLAN_PATH: "/tmp/plan.md",
      GRAPH_PATH: "/tmp/graph.json"
    });

    const contextStep = result.indexOf("--- Step 4: Write per-repo context ---");
    const workerStep = result.indexOf("--- Step 5: Spawn repo-plan workers ---");
    expect(contextStep).toBeGreaterThan(-1);
    expect(workerStep).toBeGreaterThan(contextStep);
    expect(result).toContain("consumed by the repo-plan and execution workers");
  });

  it("interpolates all placeholders in the validator instruction", () => {
    const result = loadInstruction("validator", {
      WORK_ID: "WORK-99",
      TASK_ID: "task-1",
      REPO_ID: "backend",
      WORKTREE_PATH: "/tmp/worktree",
      CONTRACT_PATH: "/tmp/contract.md",
      RESULT_PATH: "/tmp/result.json"
    });
    expect(result).not.toContain("{{WORK_ID}}");
    expect(result).not.toContain("{{RESULT_PATH}}");
    expect(result).not.toContain("{{CONTRACT_PATH}}");
  });

  it("throws when the instruction file does not exist", () => {
    expect(() => loadInstruction("nonexistent-instruction", {})).toThrow();
  });
});
