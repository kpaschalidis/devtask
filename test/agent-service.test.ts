import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent.js";
import { testAgentIntegration } from "../src/services/agent-service.js";
import { resolvePaths } from "../src/infra/paths.js";
import { initializeStore } from "../src/storage/task-store.js";
import { writeConfig } from "../src/infra/config.js";
import { DevtaskError } from "../src/infra/errors.js";
import { makeTempRepo } from "./helpers.js";

describe("agent service", () => {
  it("runs a successful agent test and captures stdout", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeDefaultConfig(paths, "codex");

    const outputs: string[] = [];
    const result = await testAgentIntegration(
      paths,
      { message: "Say hello", onOutput: (chunk) => outputs.push(chunk) },
      () => createFakeRunner("fake-agent --test"),
      async (_command, options) => {
        options.onStdout?.("hello\n");
        return { stdout: "hello\n", stderr: "", exitCode: 0 };
      }
    );

    expect(result.provider).toBe("codex");
    expect(result.prompt).toBe("Say hello");
    expect(result.response).toBe("hello");
    expect(outputs.join("")).toBe("hello\n");
  });

  it("explains command execution failures with the attempted command", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeDefaultConfig(paths, "cursor");

    await expect(
      testAgentIntegration(
        paths,
        {},
        () => createFakeRunner("agent --model test"),
        async () => ({ stdout: "", stderr: "spawn agent ENOENT", exitCode: 127 })
      )
    ).rejects.toThrow(DevtaskError);

    await expect(
      testAgentIntegration(
        paths,
        {},
        () => createFakeRunner("agent --model test"),
        async () => ({ stdout: "", stderr: "spawn agent ENOENT", exitCode: 127 })
      )
    ).rejects.toThrow("The cursor CLI does not appear to be available on PATH");
  });

  it("preserves captured output on command failure", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeDefaultConfig(paths, "codex");

    await expect(
      testAgentIntegration(
        paths,
        {},
        () => createFakeRunner("fake-agent --test"),
        async () => ({ stdout: "thinking...\n", stderr: "Approval required", exitCode: 1 })
      )
    ).rejects.toThrow("Captured output:\nthinking...");
  });

  it("deduplicates repeated agent error lines", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeDefaultConfig(paths, "codex");

    const repeatedError =
      "ERROR: You've hit your usage limit. Upgrade to Pro or try again later.";

    const error = await testAgentIntegration(
      paths,
      {},
      () => createFakeRunner("codex exec - < \"$DEVTASK_TASK_PATH\""),
      async () => ({ stdout: `${repeatedError}\n`, stderr: `${repeatedError}\n`, exitCode: 1 })
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(DevtaskError);
    expect((error as DevtaskError).message).toContain(`Error: ${repeatedError}`);
    expect((error as DevtaskError).message).not.toContain(`Error: ${repeatedError}\n${repeatedError}`);
  });

  it("fails when the agent completes without any visible reply", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeDefaultConfig(paths, "codex");

    await expect(
      testAgentIntegration(
        paths,
        {},
        () => createFakeRunner("fake-agent --test"),
        async () => ({ stdout: "", stderr: "", exitCode: 0 })
      )
    ).rejects.toThrow("completed without emitting an assistant response");
  });
});

function writeDefaultConfig(paths: ReturnType<typeof resolvePaths>, provider: "codex" | "cursor"): void {
  writeConfig(paths, {
    schemaVersion: 1,
    tracker: { provider: null },
    scm: { provider: null },
    agent: { provider },
    codex: { model: provider === "codex" ? "gpt-5.2" : null, fullAuto: true },
    runtime: { mode: "attachable", backend: "tmux" },
    runtimeConfigured: false,
    jira: { baseUrl: null, email: null, cloudId: null },
    verify: []
  });
}

function createFakeRunner(command: string): AgentRunner {
  return {
    buildStartCommand: () => command,
    start: async () => ({ id: "session-1" }),
    run: async function* () {
      return;
    }
  };
}
