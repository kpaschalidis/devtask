import { Command } from "commander";
import { readConfig, writeConfig } from "../infra/config.js";
import { resolveWorkspacePaths } from "../infra/paths.js";
import { printError } from "./common.js";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage workspace-level devtask configuration.");

  config
    .command("show")
    .description("Show the current workspace config.")
    .action(() => {
      try {
        console.log(JSON.stringify(readConfig(resolveWorkspacePaths()), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("model")
    .description("Show or set the default agent model.")
    .argument("[model]")
    .action((model?: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const current = readConfig(paths);
        if (!model) {
          console.log(current.codex.model ?? "-");
          return;
        }
        writeConfig(paths, {
          ...current,
          codex: {
            ...current.codex,
            model
          }
        });
        console.log(`Model: ${model}`);
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("jira")
    .description("Show or update Jira configuration.")
    .option("--base-url <url>")
    .option("--email <email>")
    .option("--cloud-id <cloudId>")
    .action((options: { baseUrl?: string; email?: string; cloudId?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const current = readConfig(paths);
        if (!options.baseUrl && !options.email && !options.cloudId) {
          console.log(JSON.stringify(current.jira, null, 2));
          return;
        }
        writeConfig(paths, {
          ...current,
          jira: {
            baseUrl: options.baseUrl ?? current.jira.baseUrl,
            email: options.email ?? current.jira.email,
            cloudId: options.cloudId ?? current.jira.cloudId
          }
        });
        console.log("Updated Jira config");
      } catch (error) {
        printError(error);
      }
    });
}
