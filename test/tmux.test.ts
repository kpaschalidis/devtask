import { describe, expect, it, vi } from "vitest";
import { sendToTmuxSession, tmuxSessionName } from "../src/tmux.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, error: undefined, stdout: "" }))
}));

const { spawnSync } = await import("node:child_process");
const mockedSpawnSync = vi.mocked(spawnSync);

describe("tmux", () => {
  it("uses repository identity in the session name to avoid cross-repo collisions", () => {
    const first = tmuxSessionName(
      {
        root: "/tmp/one/project",
        baseDir: "/tmp/one/project/.devtask",
        configPath: "/tmp/one/project/.devtask/config.json",
        tasksDir: "/tmp/one/project/.devtask/tasks",
        worktreesDir: "/tmp/one/project/.devtask/worktrees"
      },
      "fix.login"
    );
    const second = tmuxSessionName(
      {
        root: "/tmp/two/project",
        baseDir: "/tmp/two/project/.devtask",
        configPath: "/tmp/two/project/.devtask/config.json",
        tasksDir: "/tmp/two/project/.devtask/tasks",
        worktreesDir: "/tmp/two/project/.devtask/worktrees"
      },
      "fix.login"
    );

    expect(first).toMatch(/^devtask-project-[a-f0-9]{8}-fix-login$/);
    expect(second).toMatch(/^devtask-project-[a-f0-9]{8}-fix-login$/);
    expect(first).not.toBe(second);
  });

  it("sends short steering messages literally before submitting", () => {
    mockedSpawnSync.mockClear();

    sendToTmuxSession("devtask-test", "Use the existing router.");

    expect(mockedSpawnSync).toHaveBeenCalledWith("tmux", ["-V"], { stdio: "ignore" });
    expect(mockedSpawnSync).toHaveBeenCalledWith("tmux", ["has-session", "-t", "devtask-test"], { stdio: "ignore" });
    expect(mockedSpawnSync).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "devtask-test", "C-u"], { stdio: "ignore" });
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "devtask-test", "-l", "Use the existing router."],
      { stdio: "ignore" }
    );
    expect(mockedSpawnSync).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "devtask-test", "Enter"], { stdio: "ignore" });
  });

  it("uses a tmux buffer for multiline steering messages", () => {
    mockedSpawnSync.mockClear();

    sendToTmuxSession("devtask-test", "line one\nline two");

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["load-buffer"]),
      expect.objectContaining({ stdio: "ignore" })
    );
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["paste-buffer"]),
      expect.objectContaining({ stdio: "ignore" })
    );
  });
});
