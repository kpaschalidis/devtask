import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addRepoToGroup, createGroup, getGroup, listGroups, removeRepoFromGroup } from "../src/group-store.js";
import { resolvePaths } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("group store", () => {
  it("creates durable group metadata and planning files", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);

    const group = createGroup(paths, "billing-export", { goal: "Add billing export across repos" });

    expect(group).toMatchObject({
      schemaVersion: 1,
      id: "billing-export",
      goal: "Add billing export across repos",
      repos: []
    });
    expect(fs.existsSync(path.join(paths.groupsDir, group.id, "group.json"))).toBe(true);
    expect(fs.existsSync(path.join(paths.groupsDir, group.id, "state.md"))).toBe(true);
    expect(fs.existsSync(path.join(paths.groupsDir, group.id, "plan.md"))).toBe(true);
    expect(getGroup(paths, group.id).goal).toBe("Add billing export across repos");
  });

  it("adds repositories to a group", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const memberRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    createGroup(paths, "feature-x");

    const updated = addRepoToGroup(paths, "feature-x", {
      name: "backend",
      repoPath: memberRepo,
      taskId: "feature-x-backend"
    });

    expect(updated.repos).toEqual([
      {
        name: "backend",
        path: memberRepo,
        taskId: "feature-x-backend"
      }
    ]);
    expect(listGroups(paths).map((group) => group.id)).toEqual(["feature-x"]);
  });

  it("removes repositories from a group", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const memberRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    createGroup(paths, "feature-y");
    addRepoToGroup(paths, "feature-y", {
      name: "frontend",
      repoPath: memberRepo,
      taskId: "feature-y-frontend"
    });

    const updated = removeRepoFromGroup(paths, "feature-y", "frontend");

    expect(updated.repos).toEqual([]);
    expect(getGroup(paths, "feature-y").repos).toEqual([]);
  });

  it("can delete repo-local task metadata when removing a repo", async () => {
    const controlRepo = await makeTempRepo({ withCommit: true });
    const memberRepo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(controlRepo);
    const taskDir = path.join(memberRepo, ".devtask", "tasks", "feature-z-frontend");
    fs.mkdirSync(taskDir, { recursive: true });
    createGroup(paths, "feature-z");
    addRepoToGroup(paths, "feature-z", {
      name: "frontend",
      repoPath: memberRepo,
      taskId: "feature-z-frontend"
    });

    removeRepoFromGroup(paths, "feature-z", "frontend", { deleteTask: true });

    expect(fs.existsSync(taskDir)).toBe(false);
  });
});
