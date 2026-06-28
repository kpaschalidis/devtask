import { Command } from "commander";
import { resolveWorkspacePaths } from "devtask/infra/paths";
import {
  addRepo,
  bindRepo,
  diagnoseRepoBindings,
  getRepo,
  listRepoBindings,
  listRepos,
  removeRepo
} from "devtask/services/repo-service";
import { printError, printTable } from "../common.js";

export function registerRepoCommands(program: Command): void {
  const repo = program.command("repo").description("Manage repos inside a workspace.");

  repo
    .command("list")
    .description("List locally bound repos in the current workspace.")
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
    .description("Show one locally bound repo.")
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

  repo
    .command("bind")
    .description("Bind a shared repo id to a local clone path.")
    .argument("<repo-id>")
    .argument("[path]")
    .requiredOption("--workspace <workspace-id>")
    .option("--here", "Bind the current git repo root")
    .action((repoId: string, repoPath: string | undefined, options: { workspace: string; here?: boolean }) => {
      try {
        const bound = bindRepo(options.workspace, repoId, {
          here: options.here === true,
          path: repoPath
        });
        console.log(`Bound repo ${bound.id}`);
        console.log(`Path: ${bound.repoPath}`);
      } catch (error) {
        printError(error);
      }
    });

  repo
    .command("bindings")
    .description("List repo binding status for a workspace.")
    .requiredOption("--workspace <workspace-id>")
    .action((options: { workspace: string }) => {
      try {
        const items = listRepoBindings(options.workspace);
        if (items.length === 0) {
          console.log("No repos");
          return;
        }
        printTable(
          ["ID", "KIND", "BOUND", "PATH", "HINT", "SCOPE"],
          items.map((item) => [
            item.id,
            item.kind ?? "-",
            item.bound ? "yes" : "no",
            item.repoPath ?? "-",
            item.pathHint ?? "-",
            item.scope ?? "."
          ])
        );
      } catch (error) {
        printError(error);
      }
    });

  repo
    .command("doctor")
    .description("Validate local repo bindings for a workspace.")
    .requiredOption("--workspace <workspace-id>")
    .action((options: { workspace: string }) => {
      try {
        const issues = diagnoseRepoBindings(options.workspace);
        if (issues.length === 0) {
          console.log("Workspace repo bindings look healthy");
          return;
        }
        printTable(
          ["REPO", "SEVERITY", "MESSAGE"],
          issues.map((item) => [item.repoId, item.severity, item.message])
        );
      } catch (error) {
        printError(error);
      }
    });
}
