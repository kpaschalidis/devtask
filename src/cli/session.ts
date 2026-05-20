import { Command } from "commander";
import { resolveWorkspacePaths } from "../paths.js";
import { attachSession, getSession, listSessions, sendSessionMessage } from "../services/session-service.js";
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
          ["REPO", "TASK", "STATUS", "SESSION", "UPDATED"],
          sessions.map((entry) => [entry.repoId, entry.taskId, entry.status, entry.sessionName ?? "-", entry.updatedAt])
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
