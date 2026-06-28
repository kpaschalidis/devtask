import { Command } from "commander";
import { readConfig, writeConfig } from "devtask/infra/config";
import { resolveWorkspacePaths } from "devtask/infra/paths";
import { printError } from "../common.js";

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
    .command("tracker")
    .description("Show or set the workspace tracker provider.")
    .argument("[provider]")
    .action((provider?: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const current = readConfig(paths);
        if (!provider) {
          console.log(current.tracker.provider ?? "-");
          return;
        }
        const normalized = provider === "none" ? null : provider;
        if (normalized !== "jira" && normalized !== null) {
          throw new Error("Tracker provider must be jira or none");
        }
        writeConfig(paths, {
          ...current,
          tracker: {
            provider: normalized
          }
        });
        console.log(`Tracker: ${normalized ?? "none"}`);
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("scm")
    .description("Show or set the default workspace SCM provider.")
    .argument("[provider]")
    .action((provider?: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const current = readConfig(paths);
        if (!provider) {
          console.log(current.scm.provider ?? "-");
          return;
        }
        const normalized = provider === "none" ? null : provider;
        if (normalized !== "github" && normalized !== "bitbucket" && normalized !== "gitlab" && normalized !== null) {
          throw new Error("SCM provider must be github, bitbucket, gitlab, or none");
        }
        writeConfig(paths, {
          ...current,
          scm: {
            provider: normalized
          }
        });
        console.log(`SCM: ${normalized ?? "none"}`);
      } catch (error) {
        printError(error);
      }
    });

  config
    .command("agent")
    .description("Show or set the default agent provider.")
    .argument("[provider]")
    .action((provider?: string) => {
      try {
        const paths = resolveWorkspacePaths();
        const current = readConfig(paths);
        if (!provider) {
          console.log(current.agent.provider);
          return;
        }
        if (provider !== "codex" && provider !== "cursor" && provider !== "claude-code") {
          throw new Error(`Unsupported agent provider: ${provider}`);
        }
        writeConfig(paths, {
          ...current,
          agent: {
            provider
          }
        });
        console.log(`Agent: ${provider}`);
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
          tracker: {
            provider: "jira"
          },
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
