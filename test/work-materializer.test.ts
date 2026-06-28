import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  taskMetaPath,
  workItemGraphSnapshotPath,
  workItemMaterializationPath,
  planMarkdownPath,
  workItemRepoContextPath
} from "../src/infra/paths.js";
import { resolvePaths, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan, readWorkGraph } from "../src/services/work-materialization-service.js";
import { workItemGraphPath } from "../src/infra/paths.js";
import { readTaskMeta } from "../src/storage/meta.js";
import { makeTempRepo } from "./helpers.js";

describe("work materializer", () => {
  it("approves a graph and creates workspace-local task metadata with global worktrees", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "work-123",
      title: "Add API behavior",
      body: "Implement the backend part."
    });
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          kind: "feature",
          tasks: [
            {
              id: "backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: ["npm test"],
          openQuestions: []
        },
        null,
        2
      )
    );

    const materialization = await materializeWorkPlan(paths, item);

    expect(materialization.tasks).toHaveLength(1);
    expect(materialization.tasks[0]).toMatchObject({
      graphTaskId: "backend",
      repoId: "backend",
      taskId: "backend",
      branch: "feature/work-123-backend",
      worktreePath: path.join(paths.worktreesDir, "backend", "feature", "work-123-backend")
    });
    expect(fs.existsSync(workItemGraphSnapshotPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(workItemMaterializationPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(path.join(paths.tasksDir, "backend", "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(paths.worktreesDir, "backend", "feature", "work-123-backend"))).toBe(true);
    const meta = readTaskMeta(taskMetaPath(paths, "backend"));

    expect(meta.command).toContain(`--add-dir ${path.join(paths.workDir, item.id)}`);
    expect(meta.command).toContain(`--add-dir ${path.dirname(item.source.artifact)}`);
    expect(meta.branch).toBe("feature/work-123-backend");
    expect(meta.worktreePath).toBe(path.join(paths.worktreesDir, "backend", "feature", "work-123-backend"));
  });

  it("appends orchestrator context to task plan when context file exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-ctx-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "work-ctx",
      title: "Context test"
    });
    addWorkspaceRepo(paths, { id: "backend", repoPath: repo, kind: "api" });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(paths.workDir, item.id, "repo-plans"), { recursive: true });
    fs.writeFileSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"), "# Repo Plan\nDo the thing.\n");
    fs.writeFileSync(
      workItemRepoContextPath(paths, item.id, "backend"),
      "## Key Decisions\n- Use existing auth module.\n"
    );
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          kind: "feature",
          tasks: [{ id: "backend", repoId: "backend", goal: "Do thing.", owns: ["server/**"], dependencies: [] }],
          features: [],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await materializeWorkPlan(paths, item);

    const taskPlan = fs.readFileSync(planMarkdownPath(paths, "backend"), "utf8");
    expect(taskPlan).toContain("Do the thing.");
    expect(taskPlan).toContain("## Orchestrator Context");
    expect(taskPlan).toContain("Use existing auth module.");
  });

  it("materializes without appending context when context file is absent", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-noctx-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "work-noctx",
      title: "No context test"
    });
    addWorkspaceRepo(paths, { id: "backend", repoPath: repo, kind: "api" });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(paths.workDir, item.id, "repo-plans"), { recursive: true });
    fs.writeFileSync(path.join(paths.workDir, item.id, "repo-plans", "backend.md"), "# Repo Plan\nJust the plan.\n");
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          kind: "feature",
          tasks: [{ id: "backend", repoId: "backend", goal: "Just work.", owns: ["server/**"], dependencies: [] }],
          features: [],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await materializeWorkPlan(paths, item);

    const taskPlan = fs.readFileSync(planMarkdownPath(paths, "backend"), "utf8");
    expect(taskPlan).toContain("Just the plan.");
    expect(taskPlan).not.toContain("## Orchestrator Context");
  });

  it("rejects unknown dependency references", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-deps-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: [{ task: "missing", type: "run", reason: "Missing dependency for validation." }]
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    expect(() => readWorkGraph(paths, item.id)).toThrow("depends on unknown task missing");
  });

  it("accepts typed dependencies", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-typed-deps-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            },
            {
              id: "work-123-frontend",
              repoId: "frontend",
              goal: "Implement frontend behavior.",
              owns: ["src/**"],
              dependencies: [
                {
                  task: "work-123-backend",
                  type: "run",
                  reason: "Backend must finish before frontend starts."
                },
                {
                  task: "work-123-backend",
                  type: "validation",
                  reason: "Final validation needs both repos."
                }
              ]
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    const graph = readWorkGraph(paths, item.id);

    expect(graph.tasks[1]?.dependencies).toEqual([
      {
        task: "work-123-backend",
        type: "run",
        reason: "Backend must finish before frontend starts."
      },
      {
        task: "work-123-backend",
        type: "validation",
        reason: "Final validation needs both repos."
      }
    ]);
  });

  it("rejects invalid typed dependency types", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-bad-dep-type-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: [
                {
                  task: "work-123-other",
                  type: "maybe"
                }
              ]
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    expect(() => readWorkGraph(paths, item.id)).toThrow("dependency type must be one of");
  });

  it("rejects unknown repo ids during materialization", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-repo-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await expect(materializeWorkPlan(paths, item)).rejects.toThrow("Workspace repo backend does not exist");
  });

  it("rejects materialization when the human-readable plan artifact is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-plan-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );

    await expect(materializeWorkPlan(paths, item)).rejects.toThrow("Run devtask work orchestrate WORK-123 first");
  });

  it("reports existing materialization before repo task preflight errors", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-existing-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
      title: "Add API behavior"
    });
    addWorkspaceRepo(paths, {
      id: "backend",
      repoPath: repo,
      kind: "api"
    });
    fs.writeFileSync(path.join(paths.workDir, item.id, "plan.md"), "# Plan\n");
    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify(
        {
          schemaVersion: 1,
          workId: item.id,
          tasks: [
            {
              id: "work-123-backend",
              repoId: "backend",
              goal: "Implement backend behavior.",
              owns: ["server/**"],
              dependencies: []
            }
          ],
          validation: [],
          openQuestions: []
        },
        null,
        2
      )
    );
    await materializeWorkPlan(paths, item);

    await expect(materializeWorkPlan(paths, item)).rejects.toThrow("has already been materialized");
  });

  describe("work graph kind field", () => {
    function writeMinimalGraph(paths: ReturnType<typeof resolveWorkspacePathsForInit>, workId: string, extra: Record<string, unknown> = {}) {
      fs.writeFileSync(
        workItemGraphPath(paths, workId),
        JSON.stringify(
          {
            schemaVersion: 1,
            workId,
            tasks: [],
            features: [],
            validation: [],
            openQuestions: [],
            ...extra
          },
          null,
          2
        )
      );
    }

    it("parses 'feature' kind", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-wm-kind-"));
      const paths = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(paths);
      createManualWorkItem(paths, { id: "WORK-KIND", title: "test" });
      writeMinimalGraph(paths, "WORK-KIND", { kind: "feature" });
      const graph = readWorkGraph(paths, "WORK-KIND");
      expect(graph.kind).toBe("feature");
    });

    it("parses 'bugfix' kind", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-wm-kind-bugfix-"));
      const paths = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(paths);
      createManualWorkItem(paths, { id: "WORK-KIND", title: "test" });
      writeMinimalGraph(paths, "WORK-KIND", { kind: "bugfix" });
      const graph = readWorkGraph(paths, "WORK-KIND");
      expect(graph.kind).toBe("bugfix");
    });

    it("parses 'refactor' kind", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-wm-kind-refactor-"));
      const paths = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(paths);
      createManualWorkItem(paths, { id: "WORK-KIND", title: "test" });
      writeMinimalGraph(paths, "WORK-KIND", { kind: "refactor" });
      const graph = readWorkGraph(paths, "WORK-KIND");
      expect(graph.kind).toBe("refactor");
    });

    it("defaults to 'feature' when kind is absent", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-wm-kind-absent-"));
      const paths = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(paths);
      createManualWorkItem(paths, { id: "WORK-KIND", title: "test" });
      writeMinimalGraph(paths, "WORK-KIND");
      const graph = readWorkGraph(paths, "WORK-KIND");
      expect(graph.kind).toBe("feature");
    });

    it("defaults to 'feature' for unrecognised kind values", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-wm-kind-unknown-"));
      const paths = resolveWorkspacePathsForInit(workspace);
      initializeWorkspace(paths);
      createManualWorkItem(paths, { id: "WORK-KIND", title: "test" });
      writeMinimalGraph(paths, "WORK-KIND", { kind: "chore" });
      const graph = readWorkGraph(paths, "WORK-KIND");
      expect(graph.kind).toBe("feature");
    });
  });
});
