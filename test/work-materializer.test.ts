import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  taskMetaPath,
  workItemGraphSnapshotPath,
  workItemMaterializationPath
} from "../src/infra/paths.js";
import { resolvePaths, resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { addWorkspaceRepo } from "../src/storage/workspace-repos.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { materializeWorkPlan, readWorkGraph } from "../src/work-materializer.js";
import { workGraphPath } from "../src/global-plan.js";
import { readTaskMeta } from "../src/storage/meta.js";
import { makeTempRepo } from "./helpers.js";

describe("work materializer", () => {
  it("approves a graph and creates repo-local task worktrees", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-materializer-"));
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, {
      id: "WORK-123",
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
      workGraphPath(paths, item.id),
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
      graphTaskId: "work-123-backend",
      repoId: "backend",
      taskId: "work-123-backend",
      branch: "task/work-123-backend"
    });
    expect(fs.existsSync(workItemGraphSnapshotPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(workItemMaterializationPath(paths, item.id))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".devtask", "tasks", "work-123-backend", "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".devtask", "worktrees", "work-123-backend"))).toBe(true);
    const meta = readTaskMeta(taskMetaPath(resolvePaths(repo), "work-123-backend"));

    expect(meta.command).toContain(`--add-dir ${path.join(paths.workDir, item.id)}`);
    expect(meta.command).toContain(`--add-dir ${path.dirname(item.source.artifact)}`);
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
      workGraphPath(paths, item.id),
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
      workGraphPath(paths, item.id),
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
      workGraphPath(paths, item.id),
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
      workGraphPath(paths, item.id),
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
      workGraphPath(paths, item.id),
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

    await expect(materializeWorkPlan(paths, item)).rejects.toThrow("Run devtask work plan WORK-123 first");
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
      workGraphPath(paths, item.id),
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
});
