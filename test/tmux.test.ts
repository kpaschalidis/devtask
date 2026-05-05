import { describe, expect, it } from "vitest";
import { tmuxSessionName } from "../src/tmux.js";

describe("tmux", () => {
  it("uses repository identity in the session name to avoid cross-repo collisions", () => {
    const first = tmuxSessionName(
      {
        root: "/tmp/one/project",
        baseDir: "/tmp/one/project/.devtask",
        tasksDir: "/tmp/one/project/.devtask/tasks",
        worktreesDir: "/tmp/one/project/.devtask/worktrees"
      },
      "fix.login"
    );
    const second = tmuxSessionName(
      {
        root: "/tmp/two/project",
        baseDir: "/tmp/two/project/.devtask",
        tasksDir: "/tmp/two/project/.devtask/tasks",
        worktreesDir: "/tmp/two/project/.devtask/worktrees"
      },
      "fix.login"
    );

    expect(first).toMatch(/^devtask-project-[a-f0-9]{8}-fix-login$/);
    expect(second).toMatch(/^devtask-project-[a-f0-9]{8}-fix-login$/);
    expect(first).not.toBe(second);
  });
});
