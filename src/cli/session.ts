import { spawn } from "node:child_process";
import { Command } from "commander";
import { DevtaskError } from "../infra/errors.js";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { attachSession, buildSessionResumeCommand, getSession, listSessions, sendSessionMessage } from "../services/session-service.js";
import { printError, printTable } from "./common.js";

export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Manage repo-local agent sessions.");

  session
    .command("list")
    .description("List sessions for one work item.")
    .argument("<work-id>")
    .action(async (workId: string) => {
      try {
        const sessions = await listSessions(resolveWorkspacePaths(), workId);
        if (sessions.length === 0) {
          console.log("No sessions");
          return;
        }
        printTable(
          ["REPO", "TASK", "STATUS", "SESSION", "RUNTIME", "LAST_ACTIVITY", "SUMMARY"],
          sessions.map((entry) => [
            entry.repoId,
            entry.taskId,
            `${entry.taskStatus}/${entry.sessionStatus}`,
            entry.sessionName ?? "-",
            entry.runtimeReason ?? "-",
            entry.lastActivityAt ?? "-",
            entry.resultSummary ?? "-"
          ])
        );
      } catch (error) {
        printError(error);
      }
    });

  session
    .command("show")
    .description("Show one repo-local session.")
    .argument("<work-id>")
    .argument("<repo-id>")
    .action(async (workId: string, repoId: string) => {
      try {
        console.log(JSON.stringify(await getSession(resolveWorkspacePaths(), workId, repoId), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  session
    .command("resume")
    .description("Resume one repo-local agent session through the provider adapter.")
    .argument("<work-id>")
    .argument("<repo-id>")
    .argument("[prompt...]")
    .action(async (workId: string, repoId: string, promptParts: string[]) => {
      try {
        const command = buildSessionResumeCommand(
          resolveWorkspacePaths(),
          workId,
          repoId,
          promptParts.length > 0 ? promptParts.join(" ") : null
        );
        await runInteractiveShellCommand(command);
      } catch (error) {
        printError(error);
      }
    });

  session
    .command("attach")
    .description("Attach to one repo-local session.")
    .argument("<work-id>")
    .argument("<repo-id>")
    .action(async (workId: string, repoId: string) => {
      try {
        await attachSession(resolveWorkspacePaths(), workId, repoId);
      } catch (error) {
        printError(error);
      }
    });

  session
    .command("send")
    .description("Send a message to one repo-local session.")
    .argument("<work-id>")
    .argument("<repo-id>")
    .argument("<message...>")
    .action(async (workId: string, repoId: string, messageParts: string[]) => {
      try {
        const result = await sendSessionMessage(resolveWorkspacePaths(), workId, repoId, messageParts.join(" "));
        console.log(result.confirmed ? "Message sent; terminal output changed" : "Message sent; no terminal change observed yet");
        if (result.output.trim()) {
          console.log("");
          console.log(result.output.trimEnd());
        }
      } catch (error) {
        printError(error);
      }
    });
}

async function runInteractiveShellCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      stdio: "inherit",
      shell: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new DevtaskError(`Resume command exited with code ${code ?? "unknown"}`));
    });
  });
}
