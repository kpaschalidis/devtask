import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit, workItemGraphPath } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { createManualWorkItem } from "../src/storage/work-store.js";
import { readWorkGraph } from "../src/work-materializer.js";

describe("readWorkGraph features backward compatibility", () => {
  it("returns features: [] when graph.json has no features field", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-graph-features-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-BC", title: "Compat", body: "" });

    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify({
        schemaVersion: 1,
        workId: item.id,
        tasks: [{ id: "task-1", repoId: "app", goal: "Do something.", owns: [], dependencies: [] }],
        validation: [],
        openQuestions: []
      })
    );

    const graph = readWorkGraph(paths, item.id);
    expect(graph.features).toEqual([]);
    expect(graph.tasks[0]?.featureId).toBeNull();
  });

  it("parses features[] when present", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-graph-features-full-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);
    const item = createManualWorkItem(paths, { id: "WORK-F1", title: "Features", body: "" });

    fs.writeFileSync(
      workItemGraphPath(paths, item.id),
      JSON.stringify({
        schemaVersion: 1,
        workId: item.id,
        tasks: [
          { id: "task-a", repoId: "app", featureId: "feat-1", goal: "Task A.", owns: [], dependencies: [] }
        ],
        features: [
          { id: "feat-1", title: "Feature One", taskIds: ["task-a"], validationRequired: true }
        ],
        validation: [],
        openQuestions: []
      })
    );

    const graph = readWorkGraph(paths, item.id);
    expect(graph.features).toHaveLength(1);
    expect(graph.features[0]?.id).toBe("feat-1");
    expect(graph.features[0]?.taskIds).toEqual(["task-a"]);
    expect(graph.tasks[0]?.featureId).toBe("feat-1");
  });
});
