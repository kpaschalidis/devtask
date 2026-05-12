import { afterEach, describe, expect, it, vi } from "vitest";
import { sendToTmuxSession, sendToTmuxSessionWithConfirmation, tmuxSessionName, waitForTmuxSession } from "../src/tmux.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, error: undefined, stdout: "" }))
}));

const { spawnSync } = await import("node:child_process");
const mockedSpawnSync = vi.mocked(spawnSync);

describe("tmux", () => {
  afterEach(() => {
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockReturnValue({ status: 0, error: undefined, stdout: "" });
  });

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

  it("confirms steering delivery when captured output changes", () => {
    mockedSpawnSync.mockClear();
    mockedSpawnSync.mockImplementation((command, args) => {
      if (command === "tmux" && Array.isArray(args) && args[0] === "capture-pane") {
        const captureCount = mockedSpawnSync.mock.calls.filter((call) => Array.isArray(call[1]) && call[1][0] === "capture-pane").length;
        return { status: 0, error: undefined, stdout: captureCount === 1 ? "before" : "after" };
      }
      return { status: 0, error: undefined, stdout: "" };
    });

    const result = sendToTmuxSessionWithConfirmation("devtask-test", "hello", {
      attempts: 1,
      intervalMs: 1
    });

    expect(result).toEqual({
      confirmed: true,
      output: "after"
    });
  });

  it("returns false when a session never survives the startup window", () => {
    mockedSpawnSync.mockClear();
    mockedSpawnSync.mockImplementation((command, args) => {
      if (command === "tmux" && Array.isArray(args) && args[0] === "has-session") {
        return { status: 1, error: undefined, stdout: "" };
      }
      return { status: 0, error: undefined, stdout: "" };
    });

    expect(waitForTmuxSession("devtask-missing", { attempts: 2, intervalMs: 1 })).toBe(false);
  });
});
