import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { readConfig } from "../infra/config.js";
import { buildAgentBootstrapCommand } from "../agent.js";
import { testAgentIntegration } from "../services/agent-service.js";
import { printError } from "./common.js";

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Launch the configured agent interactively, or run agent subcommands.")
    .option("--context <path>", "File to use as the initial prompt")
    .action((options: { context?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const config = readConfig(paths);
        const prompt = options.context ? fs.readFileSync(options.context, "utf8") : undefined;
        const command = buildAgentBootstrapCommand(config, {
          workspacePath: paths.root,
          model: config.codex.model,
          fullAuto: config.codex.fullAuto,
          env: prompt ? { ...process.env, CODEX_INITIAL_PROMPT: prompt } : undefined
        });
        const result = spawnSync(command, { shell: true, stdio: "inherit", cwd: paths.root });
        if (result.error) {
          throw result.error;
        }
        if (result.status !== null && result.status !== 0) {
          process.exit(result.status);
        }
      } catch (error) {
        printError(error);
      }
    });

  agent
    .command("test")
    .description("Start the configured agent and optionally send a test prompt.")
    .argument("[message...]")
    .option("--model <model>", "Override the configured agent model")
    .option("--max-turn-ms <ms>", "Fail if the turn exceeds this duration", parseIntegerOption)
    .action(async (messageParts: string[] | undefined, options: { model?: string; maxTurnMs?: number }) => {
      try {
        const message = messageParts && messageParts.length > 0 ? messageParts.join(" ") : null;
        const result = await testAgentIntegration(resolveWorkspacePaths(), {
          message,
          model: options.model ?? null,
          maxTurnMs: options.maxTurnMs,
          onOutput: (chunk) => process.stdout.write(chunk)
        });

        console.log("");
        console.log("Agent test completed.");
      } catch (error) {
        printError(error);
      }
    });
}

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
