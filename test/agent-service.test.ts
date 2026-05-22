import { describe, expect, it } from "vitest";
import type { AgentRunner, RunEvent, SessionHandle } from "../src/agent.js";
import { testAgentIntegration } from "../src/services/agent-service.js";
import { resolvePaths } from "../src/infra/paths.js";
import { initializeStore } from "../src/storage/task-store.js";
import { writeConfig } from "../src/infra/config.js";
import { DevtaskError } from "../src/infra/errors.js";
import { makeTempRepo } from "./helpers.js";

describe("agent service", () => {
  it("runs a successful agent test and captures output", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeConfig(paths, {
      schemaVersion: 1,
      tracker: { provider: null },
      scm: { provider: null },
      agent: { provider: "codex" },
      codex: { model: "gpt-5.2", fullAuto: true },
      runtime: { mode: "attachable", backend: "tmux" },
      runtimeConfigured: false,
      jira: { baseUrl: null, email: null, cloudId: null },
      verify: []
    });

    const outputs: string[] = [];
    const result = await testAgentIntegration(
      paths,
      { message: "Say hello", onOutput: (chunk) => outputs.push(chunk) },
      () => createFakeRunner([
        { kind: "output", text: "hello\n" },
        { kind: "completed" }
      ])
    );

    expect(result.provider).toBe("codex");
    expect(result.prompt).toBe("Say hello");
    expect(result.response).toBe("hello");
    expect(outputs.join("")).toBe("hello\n");
  });

  it("explains startup failures with the attempted command", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeConfig(paths, {
      schemaVersion: 1,
      tracker: { provider: null },
      scm: { provider: null },
      agent: { provider: "cursor" },
      codex: { model: null, fullAuto: true },
      runtime: { mode: "attachable", backend: "tmux" },
      runtimeConfigured: false,
      jira: { baseUrl: null, email: null, cloudId: null },
      verify: []
    });

    await expect(
      testAgentIntegration(paths, {}, () => ({
        buildStartCommand: () => "agent --model test",
        start: async () => {
          throw new Error("spawn agent ENOENT");
        },
        run: async function* () {
          return;
        }
      }))
    ).rejects.toThrow(DevtaskError);

    await expect(
      testAgentIntegration(paths, {}, () => ({
        buildStartCommand: () => "agent --model test",
        start: async () => {
          throw new Error("spawn agent ENOENT");
        },
        run: async function* () {
          return;
        }
      }))
    ).rejects.toThrow("The cursor CLI does not appear to be available on PATH");
  });

  it("explains approval requests and preserves partial output", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    const paths = resolvePaths(repo);
    initializeStore(paths);
    writeConfig(paths, {
      schemaVersion: 1,
      tracker: { provider: null },
      scm: { provider: null },
      agent: { provider: "codex" },
      codex: { model: null, fullAuto: true },
      runtime: { mode: "attachable", backend: "tmux" },
      runtimeConfigured: false,
      jira: { baseUrl: null, email: null, cloudId: null },
      verify: []
    });

    await expect(
      testAgentIntegration(
        paths,
        {},
        () =>
          createFakeRunner([
            { kind: "output", text: "thinking...\n" },
            { kind: "input_required", prompt: "Approval required" }
          ])
      )
    ).rejects.toThrow("Partial response:\nthinking...");
  });
});

function createFakeRunner(events: RunEvent[]): AgentRunner {
  return {
    buildStartCommand: () => "fake-agent --test",
    start: async () => ({ id: "session-1" }),
    run: async function* (_session: SessionHandle, _prompt: string) {
      for (const event of events) {
        yield event;
      }
    },
    stop: async () => {}
  };
}
