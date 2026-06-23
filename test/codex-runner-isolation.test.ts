import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexExecCommand,
  configureManagedHooks,
  findSessionFileCached,
  InteractiveCodexAgent,
  prepareIsolatedCodexHome,
  updateSessionActivity
} from "@devtask/agent-kernel";

describe("codex runner isolation", () => {
  it("creates a dedicated codex home for a task run and seeds auth/config", () => {
    const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-source-"));
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-task-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceHome;
    fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"test\"}\n");
    fs.writeFileSync(path.join(sourceHome, "config.toml"), "model = \"gpt-5\"\n");

    try {
      const isolatedHome = prepareIsolatedCodexHome(taskDir, "session-1");

      expect(isolatedHome).toBe(path.join(taskDir, "codex-sessions", "session-1", ".codex"));
      expect(fs.existsSync(path.join(isolatedHome, "auth.json"))).toBe(true);
      expect(fs.existsSync(path.join(isolatedHome, "config.toml"))).toBe(true);
      expect(fs.existsSync(path.join(isolatedHome, "sessions"))).toBe(true);
      expect(fs.existsSync(path.join(isolatedHome, "logs"))).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousHome;
      }
    }
  });

  it("can seed an isolated codex home from an explicit provider session root", () => {
    const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-source-explicit-"));
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-task-explicit-"));
    fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"explicit\"}\n");

    const isolatedHome = prepareIsolatedCodexHome(taskDir, "session-2", sourceHome);

    expect(isolatedHome).toBe(path.join(taskDir, "codex-sessions", "session-2", ".codex"));
    expect(fs.readFileSync(path.join(isolatedHome, "auth.json"), "utf8")).toContain("explicit");
  });

  it("matches session files only within the dedicated sessions dir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-sessions-"));
    const workspacePath = "/tmp/project";
    const isolatedSessionsDir = path.join(root, "isolated", "sessions", "2026", "06", "11");
    const globalSessionsDir = path.join(root, "global", "sessions", "2026", "06", "11");
    fs.mkdirSync(isolatedSessionsDir, { recursive: true });
    fs.mkdirSync(globalSessionsDir, { recursive: true });

    const startedAt = Date.parse("2026-06-11T20:55:03.613Z");
    const isolatedFile = path.join(isolatedSessionsDir, "isolated.jsonl");
    const globalFile = path.join(globalSessionsDir, "global.jsonl");
    fs.writeFileSync(
      globalFile,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: workspacePath, timestamp: "2026-06-11T20:00:00.000Z", threadId: "thread-global" } })}\n`
    );
    fs.writeFileSync(
      isolatedFile,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: workspacePath, timestamp: "2026-06-11T20:55:04.000Z", threadId: "thread-isolated" } })}\n`
    );

    const matched = await findSessionFileCached(path.join(root, "isolated", "sessions"), workspacePath, startedAt);

    expect(matched).toBe(isolatedFile);
    expect(matched).not.toBe(globalFile);
  });

  it("reports the codex exec command surface used by automated runs", () => {
    const command = buildCodexExecCommand({
      model: "gpt-5",
      fullAuto: true,
      skipGitRepoCheck: true,
      addDirs: ["/tmp/project"]
    });

    expect(command).toContain("codex exec");
    expect(command).toContain("--full-auto");
    expect(command).toContain("--skip-git-repo-check");
  });

  it("refreshes session activity only when the persisted session file advances", () => {
    const initial = {
      lastActivityAtMs: 100,
      lastSessionMtimeMs: 10
    };

    expect(updateSessionActivity(initial, 10, 200)).toEqual(initial);
    expect(updateSessionActivity(initial, 9, 200)).toEqual(initial);
    expect(updateSessionActivity(initial, 11, 200)).toEqual({
      lastActivityAtMs: 200,
      lastSessionMtimeMs: 11
    });
  });

  it("writes managed stop hooks into the isolated codex home", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-hooks-"));

    configureManagedHooks(codexHome, "devtask work _phase-finalize-hook spec WORK-123 run-1");

    // hooks.json must be static (points at global stop script, not the per-session command)
    // so that codex only shows the trust prompt once, ever.
    const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const hookCommand = hooks.hooks.Stop[0]?.hooks[0]?.command;
    expect(hookCommand).toContain("stop.sh");
    expect(hookCommand).not.toContain("_phase-finalize-hook");

    // per-session command is in completion-cmd.sh
    const script = fs.readFileSync(path.join(codexHome, "completion-cmd.sh"), "utf8");
    expect(script).toContain("_phase-finalize-hook spec WORK-123 run-1");
  });

  it("removes managed stop hooks when completion is unmanaged", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-hooks-remove-"));
    const hooksPath = path.join(codexHome, "hooks.json");
    fs.writeFileSync(hooksPath, "{\"hooks\":{}}\n");

    configureManagedHooks(codexHome, null);

    expect(fs.existsSync(hooksPath)).toBe(false);
  });

  it("provisions managed hooks for interactive fresh starts", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-managed-start-"));
    const agent = new InteractiveCodexAgent({ model: "gpt-5" });

    const start = agent.createLaunchCommand("Plan work item WORK-123.", "session-start", {
      taskDir,
      addDirs: [taskDir],
      managedCompletionCommand: "devtask work _phase-finalize-hook spec WORK-123 run-1"
    });

    expect(fs.existsSync(path.join(String(start.metadata.codexHome), "hooks.json"))).toBe(true);
    expect(start.command).toContain("--dangerously-bypass-hook-trust");
  });

  it("updates managed hooks for interactive resumes and clears them for unmanaged attach", async () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-managed-resume-"));
    const codexHome = prepareIsolatedCodexHome(taskDir, "session-resume");
    const agent = new InteractiveCodexAgent({ model: "gpt-5" });
    const handle = {
      id: "session-resume",
      runtimeName: "tmux",
      data: {
        threadId: "thread-123",
        codexHome,
        resumePrompt: "Continue"
      }
    };

    configureManagedHooks(codexHome, "devtask work _phase-finalize-hook plan WORK-123 run-2");
    const managed = await agent.getRestoreCommand(handle);
    expect(managed).toContain("codex resume --dangerously-bypass-hook-trust");
    expect(fs.readFileSync(path.join(codexHome, "completion-cmd.sh"), "utf8")).toContain("_phase-finalize-hook plan WORK-123 run-2");

    configureManagedHooks(codexHome, null);
    delete handle.data.resumePrompt;
    const unmanaged = await agent.getRestoreCommand(handle);
    expect(unmanaged).toContain("codex resume");
    expect(fs.existsSync(path.join(codexHome, "hooks.json"))).toBe(false);
  });
});
