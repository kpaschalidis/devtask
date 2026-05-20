import { Command } from "commander";
import { resolveWorkspacePaths } from "../paths.js";
import { addRepo, getRepo, listRepos, removeRepo } from "../services/repo-service.js";
import { printError, printTable } from "./common.js";

export function registerRepoCommands(program: Command): void {
  const repo = program.command("repo").description("Manage repos inside the current workspace.");

  repo
    .command("list")
    .description("List repos in the current workspace.")
    .action(() => {
      try {
        const paths = resolveWorkspacePaths();
        const repos = listRepos(paths);
        if (repos.length === 0) {
          console.log("No repos");
          return;
        }
        printTable(
          ["ID", "KIND", "PATH", "SCOPE"],
          repos.map((item) => [item.id, item.kind ?? "-", item.repoPath, item.scope ?? "."])
        );
      } catch (error) {
        printError(error);
      }
    });

  repo
    .command("show")
    .description("Show one repo.")
    .argument("<repo-id>")
    .action((repoId: string) => {
      try {
        console.log(JSON.stringify(getRepo(resolveWorkspacePaths(), repoId), null, 2));
      } catch (error) {
        printError(error);
      }
    });

  repo
    .command("add")
    .description("Add a repo to the current workspace.")
    .argument("<repo-id>")
    .argument("<path>")
    .option("--kind <kind>")
    .option("--scope <scope>")
    .action((repoId: string, repoPath: string, options: { kind?: string; scope?: string }) => {
      try {
        const added = addRepo(resolveWorkspacePaths(), {
          id: repoId,
          path: repoPath,
          kind: options.kind ?? null,
          scope: options.scope ?? null
        });
        console.log(`Added repo ${added.id}`);
        console.log(`Path: ${added.repoPath}`);
      } catch (error) {
        printError(error);
      }
    });

  repo
    .command("remove")
    .description("Remove a repo from the current workspace.")
    .argument("<repo-id>")
    .action((repoId: string) => {
      try {
        const removed = removeRepo(resolveWorkspacePaths(), repoId);
        console.log(`Removed repo ${removed.id}`);
      } catch (error) {
        printError(error);
      }
    });
}
