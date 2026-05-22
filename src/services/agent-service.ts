import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { AgentRunner, RunEvent } from "../agent.js";
import { createDefaultAgentRunner } from "../agent.js";
import { readConfig } from "../infra/config.js";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";

const DEFAULT_TEST_PROMPT = [
  "This is a devtask agent integration test.",
  "Reply with exactly: DEVTASK_AGENT_TEST_OK",
  "Do not modify files, run tools, or add extra commentary."
].join("\n");

export interface AgentTestOptions {
  message?: string | null;
  model?: string | null;
  stallMs?: number;
  maxTurnMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface AgentTestResult {
  provider: "codex" | "cursor";
  model: string | null;
  workspacePath: string;
  command: string;
  prompt: string;
  response: string;
}

export async function testAgentIntegration(
  paths: DevtaskPaths,
  options: AgentTestOptions = {},
  runnerFactory: (typeof createDefaultAgentRunner) = createDefaultAgentRunner
): Promise<AgentTestResult> {
  const config = readConfig(paths);
  const runner = runnerFactory(config);
  const prompt = options.message?.trim() ? options.message.trim() : DEFAULT_TEST_PROMPT;
  const startOptions = {
    workspacePath: paths.root,
    model: options.model ?? config.codex.model,
    fullAuto: false,
    skipGitRepoCheck: true
  } as const;
  const command = runner.buildStartCommand?.(startOptions) ?? "agent-run";

  let session = null as Awaited<ReturnType<AgentRunner["start"]>> | null;
  const outputChunks: string[] = [];

  try {
    try {
      session = await runner.start(startOptions);
    } catch (error) {
      throw new DevtaskError(formatAgentTestFailure({
        provider: config.agent.provider,
        workspacePath: paths.root,
        command,
        prompt,
        stage: "startup",
        error,
        response: ""
      }));
    }

    for await (const event of runner.run(session, prompt, {
      stallMs: options.stallMs,
      maxTurnMs: options.maxTurnMs
    })) {
      if (event.kind === "output") {
        outputChunks.push(event.text);
        options.onOutput?.(event.text);
        continue;
      }

      if (event.kind === "completed") {
        return {
          provider: config.agent.provider,
          model: startOptions.model,
          workspacePath: paths.root,
          command,
          prompt,
          response: outputChunks.join("").trim()
        };
      }

      throw new DevtaskError(formatAgentTestFailure({
        provider: config.agent.provider,
        workspacePath: paths.root,
        command,
        prompt,
        stage: event.kind,
        error: "error" in event ? event.error : "prompt" in event ? event.prompt : null,
        response: outputChunks.join("").trim()
      }));
    }

    throw new DevtaskError(formatAgentTestFailure({
      provider: config.agent.provider,
      workspacePath: paths.root,
      command,
      prompt,
      stage: "failed",
      error: "Agent exited without a completion event.",
      response: outputChunks.join("").trim()
    }));
  } finally {
    if (session && runner.stop) {
      await runner.stop(session);
    }
  }
}

interface FailureContext {
  provider: "codex" | "cursor";
  workspacePath: string;
  command: string;
  prompt: string;
  stage: "startup" | Exclude<RunEvent["kind"], "output" | "completed">;
  error: unknown;
  response: string;
}

function formatAgentTestFailure(context: FailureContext): string {
  const details = [
    "Agent integration test failed.",
    `Provider: ${context.provider}`,
    `Workspace: ${context.workspacePath}`,
    `Command: ${context.command}`,
    `Stage: ${context.stage}`,
    `Prompt: ${context.prompt}`
  ];

  const errorText = normalizeErrorText(context.error);
  if (errorText) {
    details.push(`Error: ${errorText}`);
  }

  const explanation = explainAgentTestFailure(context.stage, errorText, context.provider);
  if (explanation) {
    details.push(`Explanation: ${explanation}`);
  }

  if (context.response) {
    details.push("Partial response:");
    details.push(context.response);
  }

  return details.join("\n");
}

function explainAgentTestFailure(
  stage: FailureContext["stage"],
  errorText: string | null,
  provider: FailureContext["provider"]
): string | null {
  if (stage === "input_required") {
    return "The agent asked for manual approval or confirmation instead of producing a direct reply.";
  }

  if (stage === "stalled") {
    return "The agent session produced no completion signal before the timeout expired.";
  }

  if (!errorText) {
    return null;
  }

  if (errorText.includes("tmux is not available")) {
    return "tmux is required for the current agent runner path. Install tmux and retry.";
  }

  if (errorText.includes("did not become ready in time")) {
    return `The ${provider} CLI started but never reached a ready prompt. This usually means first-run setup, authentication, or an interactive banner blocked startup.`;
  }

  if (errorText.includes("not found") || errorText.includes("ENOENT")) {
    return `The ${provider} CLI does not appear to be available on PATH in this shell environment.`;
  }

  return null;
}

function normalizeErrorText(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error == null) {
    return null;
  }
  return String(error);
}

export async function createAgentTestOutputPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devtask-agent-test-"));
  return path.join(dir, "output.txt");
}
