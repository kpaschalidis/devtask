import { Command } from "commander";
import { resolvePaths, resolveWorkspacePaths } from "../paths.js";
import { createTask, initializeStore } from "../task-store.js";
import { readConfig } from "../config.js";
import { assertJiraConfigured, buildJiraTaskGoal, fetchJiraIssue, writeJiraSourceArtifacts } from "../jira.js";
import { defaultTaskIdForIssue, printError } from "./support.js";

export function registerJiraCommands(program: Command): void {
  const jira = program.command("jira").description("Use Jira issues as durable devtask source inputs.");

  jira
    .command("doctor")
    .description("Check Jira configuration and environment.")
    .option("--issue <issue-key>", "Validate Jira access by fetching a specific issue")
    .action(async (options: { issue?: string }) => {
      try {
        const paths = resolveWorkspacePaths();
        const config = readConfig(paths);
        console.log(`baseUrl: ${config.jira.baseUrl ?? "-"}`);
        console.log(`email: ${config.jira.email ?? "-"}`);
        console.log(`cloudId: ${config.jira.cloudId ?? "-"}`);
        console.log(`JIRA_API_TOKEN: ${process.env.JIRA_API_TOKEN ? "set" : "missing"}`);
        const auth = assertJiraConfigured(config);
        console.log(`mode: ${auth.mode}`);
        if (!options.issue) {
          console.log("Jira: configured");
          console.log("Validation: skipped. Use devtask jira doctor --issue <issue-key> to validate issue access.");
          return;
        }
        const issue = await fetchJiraIssue(config, options.issue);
        console.log(`Issue: ${issue.key} - ${issue.summary}`);
        console.log("Jira: issue access verified");
      } catch (error) {
        printError(error);
      }
    });

  jira
    .command("fetch")
    .description("Fetch a Jira issue and write durable source artifacts.")
    .argument("<issue-key>")
    .action(async (issueKey: string) => {
      try {
        const paths = resolveWorkspacePaths();
        initializeStore(paths);
        const issue = await fetchJiraIssue(readConfig(paths), issueKey);
        const artifacts = writeJiraSourceArtifacts(paths, issue);
        console.log(`${issue.key}: ${issue.summary}`);
        console.log(`JSON: ${artifacts.jsonPath}`);
        console.log(`Markdown: ${artifacts.markdownPath}`);
      } catch (error) {
        printError(error);
      }
    });

  jira
    .command("create")
    .description("Create a repo-local task from a Jira issue.")
    .argument("<issue-key>")
    .option("--task <task-id>", "Task id to create. Defaults to lower-case Jira key.")
    .action(async (issueKey: string, options: { task?: string }) => {
      try {
        const paths = resolvePaths();
        initializeStore(paths);
        const issue = await fetchJiraIssue(readConfig(paths), issueKey);
        const artifacts = writeJiraSourceArtifacts(paths, issue);
        const taskId = options.task ?? defaultTaskIdForIssue(issue.key);
        const meta = await createTask(paths, taskId, {
          goal: buildJiraTaskGoal(issue, artifacts.markdownPath)
        });
        console.log(`Fetched ${issue.key}: ${issue.summary}`);
        console.log(`Source: ${artifacts.markdownPath}`);
        console.log(`Created task ${meta.id}`);
        console.log(`Branch: ${meta.branch}`);
        console.log(`Worktree: ${meta.worktreePath}`);
      } catch (error) {
        printError(error);
      }
    });


}
