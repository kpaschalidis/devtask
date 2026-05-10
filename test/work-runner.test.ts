import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTaskMeta, writeTaskMeta } from "../src/meta.js";
import { resolveWorkspacePathsForInit, taskMetaPath } from "../src/paths.js";
import { initializeWorkspace } from "../src/task-store.js";
import { approveWorkPlan } from "../src/work-materializer.js";
import { workGraphPath, workPlanPath } from "../src/work-planner.js";
import { createWorkRepoPlans } from "../src/work-repo-planner.js";
import { planWorkRun } from "../src/work-runner.js";
import { createManualWorkItem } from "../src/work-store.js";
import { addWorkspaceTarget } from "../src/workspace-targets.js";
import { makeTempRepo } from "./helpers.js";

describe("work runner", () => {
  it("marks dependency-free planned tasks ready to run", async () => {
    const fixture = await makeFixture({ withDependency: false });
    createWorkRepoPlans(fixture.paths, fixture.item);

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [
        {
          target: "backend",
          taskId: "work-123-backend"
        },
        {
          target: "frontend",
          taskId: "work-123-frontend"
        }
      ],
      skipped: []
    });
  });

  it("waits for unfinished dependencies", async () => {
    const fixture = await makeFixture({ withDependency: true });
    createWorkRepoPlans(fixture.paths, fixture.item);

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [
        {
          target: "backend",
          taskId: "work-123-backend"
        }
      ],
      skipped: [
        {
          target: "frontend",
          taskId: "work-123-frontend",
          reason: "waiting for work-123-backend"
        }
      ]
    });
  });

  it("allows dependent tasks after dependencies are done", async () => {
    const fixture = await makeFixture({ withDependency: true });
    createWorkRepoPlans(fixture.paths, fixture.item);
    const backendMetaPath = taskMetaPath(fixture.backendPaths, "work-123-backend");
    writeTaskMeta(backendMetaPath, {
      ...readTaskMeta(backendMetaPath),
      status: "done"
    });

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [
        {
          target: "frontend",
          taskId: "work-123-frontend"
        }
      ]
    });
  });

  it("does not block running on validation-only dependencies", async () => {
    const fixture = await makeFixture({ withDependency: false, dependencyType: "validation" });
    createWorkRepoPlans(fixture.paths, fixture.item);

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [
        {
          target: "backend",
          taskId: "work-123-backend"
        },
        {
          target: "frontend",
          taskId: "work-123-frontend"
        }
      ],
      skipped: []
    });
  });

  it("explains tasks that still need repo planning", async () => {
    const fixture = await makeFixture({ withDependency: false });

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [],
      skipped: [
        {
          target: "backend",
          taskId: "work-123-backend",
          reason: "needs repo-plan"
        },
        {
          target: "frontend",
          taskId: "work-123-frontend",
          reason: "needs repo-plan"
        }
      ]
    });
  });

  it("does not start tasks that already have a live supervisor", async () => {
    const fixture = await makeFixture({ withDependency: false });
    createWorkRepoPlans(fixture.paths, fixture.item);
    const backendMetaPath = taskMetaPath(fixture.backendPaths, "work-123-backend");
    writeTaskMeta(backendMetaPath, {
      ...readTaskMeta(backendMetaPath),
      supervisorPid: process.pid
    });

    expect(planWorkRun(fixture.paths, fixture.item)).toMatchObject({
      ready: [
        {
          target: "frontend",
          taskId: "work-123-frontend"
        }
      ],
      skipped: [
        {
          target: "backend",
          taskId: "work-123-backend",
          reason: `already supervised by PID ${process.pid}`
        }
      ]
    });
  });
});

async function makeFixture(options: { withDependency: boolean; dependencyType?: "run" | "validation" }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-work-runner-"));
  const backendRepo = await makeTempRepo({ withCommit: true });
  const frontendRepo = await makeTempRepo({ withCommit: true });
  const paths = resolveWorkspacePathsForInit(workspace);
  const backendPaths = resolveWorkspacePathsForInit(fs.realpathSync(backendRepo));
  const frontendPaths = resolveWorkspacePathsForInit(fs.realpathSync(frontendRepo));
  initializeWorkspace(paths);
  const item = createManualWorkItem(paths, {
    id: "WORK-123",
    title: "Add full-stack behavior"
  });
  addWorkspaceTarget(paths, {
    id: "backend",
    repoPath: backendRepo,
    kind: "api"
  });
  addWorkspaceTarget(paths, {
    id: "frontend",
    repoPath: frontendRepo,
    kind: "web"
  });
  fs.writeFileSync(workPlanPath(paths, item.id), "# Work Plan\n\nCoordinate backend and frontend behavior.\n");
  fs.writeFileSync(
    workGraphPath(paths, item.id),
    JSON.stringify(
      {
        schemaVersion: 1,
        workId: item.id,
        tasks: [
          {
            id: "work-123-backend",
            target: "backend",
            goal: "Implement backend behavior.",
            owns: ["server/**"],
            dependsOn: []
          },
          {
            id: "work-123-frontend",
            target: "frontend",
            goal: "Implement frontend behavior.",
            owns: ["src/**"],
            ...(options.withDependency ? { dependsOn: ["work-123-backend"] } : {}),
            ...(options.dependencyType
              ? {
                  dependencies: [
                    {
                      task: "work-123-backend",
                      type: options.dependencyType,
                      reason: "Coordinate backend and frontend validation."
                    }
                  ]
                }
              : {})
          }
        ],
        validation: [],
        openQuestions: []
      },
      null,
      2
    )
  );
  await approveWorkPlan(paths, item);
  return { paths, item, backendPaths, frontendPaths };
}
