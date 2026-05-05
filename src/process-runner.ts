import { spawn } from "node:child_process";
import { DevtaskError } from "./errors.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function runCommand(file: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function runCommandOrThrow(file: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  const result = await runCommand(file, args, options);
  if (result.exitCode !== 0) {
    throw new DevtaskError(
      `Command failed: ${[file, ...args].join(" ")}\n${result.stderr || result.stdout}`.trim()
    );
  }
  return result;
}
