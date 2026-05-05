import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addRepoToGroup, createGroup, getGroup, listGroups } from "../src/group-store.js";
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
});
