import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { buildAgentBootstrapCommand } from "../adapters/agent-kernel/command.js";
import { readConfig } from "../infra/config.js";
import type { DevtaskConfig } from "../infra/config.js";
import { DevtaskError } from "../infra/errors.js";
import type { DevtaskPaths } from "../infra/paths.js";

const DEFAULT_TEST_PROMPT = [
  "This is a devtask agent integration test.",
  "Reply with exactly: DEVTASK_AGENT_TEST_OK",
  "Do not modify files, run tools, or add extra commentary."
].join("\n");

const DEFAULT_MAX_TURN_MS = 120_000;

export interface AgentTestOptions {
  message?: string | null;
  model?: string | null;
  maxTurnMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface AgentTestResult {
  provider: "codex" | "cursor" | "claude-code";
  model: string | null;
  workspacePath: string;
  command: string;
  prompt: string;
  response: string;
}

interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

type ShellCommandExecutor = (
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onStdout?: (chunk: string) => void;
  }
) => Promise<ShellCommandResult>;

type AgentCommandBuilder = (
  config: DevtaskConfig,
  options: { model: string | null; fullAuto: boolean; skipGitRepoCheck: boolean },
) => string;

export async function testAgentIntegration(
  paths: DevtaskPaths,
  options: AgentTestOptions = {},
  commandBuilder: AgentCommandBuilder = buildAgentTestCommand,
  commandExecutor: ShellCommandExecutor = runShellCommand
): Promise<AgentTestResult> {
  const config = readConfig(paths);
  const prompt = options.message?.trim() ? options.message.trim() : DEFAULT_TEST_PROMPT;
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "devtask-agent-test-"));
  const promptPath = path.join(promptDir, "prompt.txt");

  await fs.writeFile(promptPath, `${prompt}\n`, "utf8");

  const startOptions = {
    workspacePath: paths.root,
    model: options.model ?? config.codex.model,
    fullAuto: false,
    skipGitRepoCheck: true,
    env: {
      ...buildSanitizedAgentEnv(process.env),
      DEVTASK_TASK_DIR: promptDir,
      DEVTASK_TASK_PATH: promptPath
    }
  } as const;
  const command = commandBuilder(config, startOptions);

  try {
    const result = await commandExecutor(command, {
      cwd: paths.root,
      env: startOptions.env,
      timeoutMs: options.maxTurnMs ?? DEFAULT_MAX_TURN_MS,
      onStdout: options.onOutput
    });

    const stdout = normalizeAgentCliOutput(result.stdout, prompt, config.agent.provider);
    const stderr = summarizeAgentCliError(result.stderr, result.stdout);

    if (result.exitCode !== 0) {
      throw new DevtaskError(formatAgentTestFailure({
        provider: config.agent.provider,
        workspacePath: paths.root,
        command,
        prompt,
        stage: "failed",
        error: stderr || stdout || `Process exited with code ${result.exitCode}`,
        response: stdout
      }));
    }

    if (!stdout) {
      throw new DevtaskError(formatAgentTestFailure({
        provider: config.agent.provider,
        workspacePath: paths.root,
        command,
        prompt,
        stage: "failed",
        error: "Agent completed without emitting an assistant response.",
        response: stderr
      }));
    }

    return {
      provider: config.agent.provider,
      model: startOptions.model,
      workspacePath: paths.root,
      command,
      prompt,
      response: stdout
    };
  } finally {
    await fs.rm(promptDir, { recursive: true, force: true });
  }
}

function buildAgentTestCommand(
  config: DevtaskConfig,
  options: { model: string | null; fullAuto: boolean; skipGitRepoCheck: boolean },
): string {
  return buildAgentBootstrapCommand(config, {
    workspacePath: "",
    model: options.model,
    fullAuto: options.fullAuto,
    skipGitRepoCheck: options.skipGitRepoCheck,
  });
}

interface FailureContext {
  provider: "codex" | "cursor" | "claude-code";
  workspacePath: string;
  command: string;
  prompt: string;
  stage: "startup" | "failed";
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

  const explanation = explainAgentTestFailure(errorText, context.provider);
  if (explanation) {
    details.push(`Explanation: ${explanation}`);
  }

  if (context.response) {
    details.push("Captured output:");
    details.push(context.response);
  }

  return details.join("\n");
}

function explainAgentTestFailure(errorText: string | null, provider: FailureContext["provider"]): string | null {
  if (!errorText) {
    return null;
  }

  if (errorText.includes("timed out")) {
    return `The ${provider} CLI did not finish within the allowed timeout.`;
  }

  if (errorText.includes("tmux is not available")) {
    return "tmux is required for the current agent runner path. Install tmux and retry.";
  }

  if (errorText.includes("completed without emitting an assistant response")) {
    return `The ${provider} CLI finished successfully, but did not print a reply to stdout.`;
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

function normalizeAgentCliOutput(rawOutput: string, prompt: string, provider: "codex" | "cursor" | "claude-code"): string {
  const lines = rawOutput
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => !isIgnorableAgentLine(line));

  if (provider === "codex") {
    const userIndex = lines.findIndex((line) => line.trim() === "user");
    if (userIndex !== -1) {
      let start = userIndex + 1;
      while (start < lines.length && lines[start]!.trim() === "") {
        start += 1;
      }
      if (start < lines.length && lines[start]!.trim() === prompt.trim()) {
        start += 1;
      }
      while (start < lines.length && lines[start]!.trim() === "") {
        start += 1;
      }
      return lines.slice(start).join("\n").trim();
    }
  }

  return lines.join("\n").trim();
}

function summarizeAgentCliError(stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`;
  const errorLines = uniqueLines(
    combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ERROR:"))
  );

  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }

  const cleaned = uniqueLines(
    combined
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => !isIgnorableAgentLine(line))
  )
    .join("\n")
    .trim();

  return cleaned;
}

function isIgnorableAgentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed === "--------" ||
    trimmed === "user" ||
    trimmed.startsWith("OpenAI Codex v") ||
    trimmed.startsWith("workdir:") ||
    trimmed.startsWith("model:") ||
    trimmed.startsWith("provider:") ||
    trimmed.startsWith("approval:") ||
    trimmed.startsWith("sandbox:") ||
    trimmed.startsWith("reasoning effort:") ||
    trimmed.startsWith("reasoning summaries:") ||
    trimmed.startsWith("session id:")
  ) {
    return true;
  }

  if (/^\d{4}-\d{2}-\d{2}T.*\sWARN\s/.test(trimmed)) {
    return true;
  }

  return false;
}

function uniqueLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }

  return result;
}

function buildSanitizedAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_CI;
  delete env.CODEX_SHELL;
  return env;
}

async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onStdout?: (chunk: string) => void;
  }
): Promise<ShellCommandResult> {
  return await new Promise<ShellCommandResult>((resolve, reject) => {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-lc", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        resolve({
          stdout,
          stderr: `${stderr}\nCommand timed out after ${options.timeoutMs}ms.`.trim(),
          exitCode
        });
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}
