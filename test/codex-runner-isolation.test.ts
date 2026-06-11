import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAgentRunner,
  findCodexSessionFileInDirForTest,
  prepareIsolatedCodexHomeForTest,
  updateSessionActivity
} from "../src/adapters/codex/index.js";

describe("codex runner isolation", () => {
  it("creates a dedicated codex home for a task run and seeds auth/config", () => {
    const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-source-"));
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-codex-task-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceHome;
    fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"test\"}\n");
    fs.writeFileSync(path.join(sourceHome, "config.toml"), "model = \"gpt-5\"\n");

    try {
      const isolatedHome = prepareIsolatedCodexHomeForTest(taskDir, "session-1");

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

    const matched = await findCodexSessionFileInDirForTest(path.join(root, "isolated", "sessions"), workspacePath, startedAt);

    expect(matched).toBe(isolatedFile);
    expect(matched).not.toBe(globalFile);
  });

  it("reports the codex exec command surface used by automated runs", () => {
    const runner = new CodexAgentRunner({ model: "gpt-5" });

    const command = runner.buildStartCommand({
      workspacePath: "/tmp/project",
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
});
