import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DevtaskError } from "../errors.js";
import { planMarkdownPath, resolvePaths, resolveWorkspacePaths, scriptsDir, startupDir, taskMetaPath } from "../paths.js";
import { writeTaskMeta } from "../meta.js";
import { isProcessAlive, terminateProcessGroup } from "../processes.js";
import { getTask, listTasks } from "../task-store.js";
import { buildTaskReview, inspectTaskHealth, readLatestLogPath, readLatestRun } from "../task-inspection.js";
import { attachTmuxSession, isTmuxAvailable, killTmuxSession, sendToTmuxSessionWithConfirmation, startTmuxSession, tmuxSessionExists, tmuxSessionName, waitForTmuxSession } from "../tmux.js";
import { buildCodexCommand, readConfig, writeConfig } from "../config.js";
import { assertCanMark, parseManualStatus } from "../lifecycle.js";
import { readLatestVerification, runVerification, type VerificationRecord } from "../verification.js";
import { runCommand, runCommandOrThrow } from "../process-runner.js";
import { readLatestReviewAgent, runReviewAgent, type ReviewAgentRecord } from "../review-agent.js";
import { hasTaskPlan, runPlanAgent } from "../planner.js";
import { buildBoardRow, type NextAction } from "../workflow.js";
import { type CleanupOptions, type CleanupPlan } from "../cleanup.js";
import { assertValidTaskId } from "../task-id.js";
import { checkProviderCi, countBranchCommits, createProviderPullRequest, detectRemoteInfo, hasUncommittedChanges, preflightScmForPullRequest, type ScmPreflight } from "../scm.js";
import { readStageLedger, recordStage, runStage, STAGE_NAMES, type StageName } from "../stage-contracts.js";
import { assertCheckReady, assertCiReady, assertCommitReady, assertPrReady, assertReviewReady, assertRunReady } from "../stage-policy.js";
import { renderJiraIssueMarkdown, type JiraIssue } from "../jira.js";
import { type WorkspaceTarget } from "../workspace-targets.js";
import { type WorkItem } from "../work-store.js";
import { readLatestWorkPlanRecord, workGraphPath, workPlanPath, workPlansDir } from "../work-planner.js";
import { readWorkMaterialization } from "../work-materializer.js";
import { buildWorkBoardRows, type WorkBoardRow } from "../work-board.js";
import { isWorkTaskRunComplete, planWorkRun } from "../work-runner.js";
import { DEFAULT_DEV_WORKFLOW, runWorkflowStage, workflowStageFailed, type WorkflowStageId, type WorkflowUnit } from "../workflow-engine.js";
import { createFixRequestFromCheck } from "../fix-request.js";
import { readWorkStageLedger, WORK_STAGE_NAMES, type WorkStageContract } from "../work-stage-contracts.js";


export function printError(error: unknown): never {
  if (error instanceof DevtaskError) {
    console.error(`devtask: ${error.message}`);
    process.exit(1);
  }

  throw error;
}

export interface PrOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  ready?: boolean;
  target?: string;
}

export type LogStage = "current" | "latest" | "run" | "check" | "fix" | "review";
const ATTACHABLE_STAGE_NAMES = ["plan", "run", "fix", "review"] as const satisfies readonly StageName[];

export interface StartedWorker {
  pid: number | null;
  tmuxSession: string | null;
  startupLogPath?: string | null;
}

export function printStartedWorker(
  id: string,
  started: StartedWorker,
  verb: "Running" | "Continuing" | "Fixing",
  commands?: { attach: string; steer: string }
): void {
  console.log(`${verb} task ${id}`);
  if (started.tmuxSession) {
    console.log(`tmux: ${started.tmuxSession}`);
    if (started.startupLogPath) {
      console.log(`Startup log: ${started.startupLogPath}`);
    }
    console.log(`Attach: ${commands?.attach ?? `devtask task attach ${id}`}`);
    console.log(`Steer: ${commands?.steer ?? `devtask task steer ${id} "message"`}`);
    return;
  }
  console.log("Runtime: plain (attach/steer unavailable)");
  console.log(`Supervisor PID: ${started.pid ?? "-"}`);
}

export function printNextAction(id: string, next: NextAction): void {
  console.log(id);
  console.log(`  ${next.reason}`);
  if (next.command) {
    console.log(`  Next: ${next.command}`);
  } else {
    console.log("  Next: -");
  }
}

export function configureRuntimeFromEnvironment(paths: ReturnType<typeof resolvePaths>): void {
  const current = readConfig(paths);
  if (isTmuxAvailable()) {
    writeConfig(paths, {
      ...current,
      runtime: {
        mode: "attachable",
        backend: "tmux"
      },
      runtimeConfigured: true
    });
    console.log("Runtime: attachable (tmux)");
    return;
  }

  writeConfig(paths, {
    ...current,
    runtime: {
      mode: "plain",
      backend: null
    },
    runtimeConfigured: true
  });
  console.log("Runtime: plain");
  console.log("tmux is not installed. devtask can still run tasks in plain background mode, but attach and steer will not be available.");
  console.log("Install tmux, then run: devtask config runtime attachable");
}

export function parseRuntimeMode(mode: string): ReturnType<typeof readConfig>["runtime"] {
  if (mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is not available. Install tmux before enabling attachable runtime.");
    }
    return {
      mode: "attachable",
      backend: "tmux"
    };
  }

  if (mode === "plain") {
    return {
      mode: "plain",
      backend: null
    };
  }

  throw new DevtaskError('Invalid runtime mode. Use "attachable" or "plain".');
}

export function formatRuntime(config: ReturnType<typeof readConfig>): string {
  return config.runtime.mode === "attachable" ? "attachable (tmux)" : "plain";
}

export function resolveRunRuntime(
  paths: ReturnType<typeof resolvePaths>,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): { tmux: boolean } {
  const requestedAttachable = options.attachable === true || options.tmux === true;
  if (options.plain === true && requestedAttachable) {
    throw new DevtaskError("Use either --attachable/--tmux or --plain, not both");
  }

  if (options.plain === true) {
    warnPlainRuntime();
    return { tmux: false };
  }

  const config = readConfig(paths);
  if (requestedAttachable || config.runtime.mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is required for attachable sessions. Install tmux or run devtask task run <id> --plain.");
    }
    return { tmux: true };
  }

  warnPlainRuntime();
  return { tmux: false };
}

export function startStageSessionIfRequested(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  stage: string,
  args: string[],
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): boolean {
  if (!resolveStageAttachable(paths, options)) {
    return false;
  }

  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new DevtaskError("Unable to determine devtask CLI path for attachable stage session");
  }

  const session = stageTmuxSessionName(paths, id, stage);
  startTmuxSession(session, [process.execPath, cliPath, ...args], paths.root);
  console.log(`Started ${stage} in tmux: ${session}`);
  console.log(`Attach: tmux attach -t ${shellQuote(session)}`);
  return true;
}

function resolveStageAttachable(
  paths: ReturnType<typeof resolvePaths>,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): boolean {
  const requestedAttachable = options.attachable === true || options.tmux === true;
  if (options.plain === true && requestedAttachable) {
    throw new DevtaskError("Use either --attachable/--tmux or --plain, not both");
  }
  if (options.plain === true) {
    return false;
  }

  const config = readConfig(paths);
  if (requestedAttachable || config.runtime.mode === "attachable") {
    if (!isTmuxAvailable()) {
      throw new DevtaskError("tmux is required for attachable stage sessions. Install tmux or use --plain.");
    }
    return true;
  }
  return false;
}

function stageTmuxSessionName(paths: ReturnType<typeof resolvePaths>, id: string, stage: string): string {
  return `${tmuxSessionName(paths, id)}-${stage.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function resolveAttachSession(paths: ReturnType<typeof resolvePaths>, meta: ReturnType<typeof getTask>, stage?: string): string {
  if (!stage) {
    return meta.tmuxSession ?? tmuxSessionName(paths, meta.id);
  }
  return resolveLifecycleStageSession(paths, meta, stage);
}

function resolveLifecycleStageSession(paths: ReturnType<typeof resolvePaths>, meta: ReturnType<typeof getTask>, stage: string): string {
  const stageName = parseLifecycleStage(stage);
  if (stageName === "run" || stageName === "fix") {
    return meta.tmuxSession ?? tmuxSessionName(paths, meta.id);
  }
  return stageTmuxSessionName(paths, meta.id, stageName);
}

function parseLifecycleStage(stage: string): StageName {
  if (STAGE_NAMES.includes(stage as StageName)) {
    const parsed = stage as StageName;
    if (ATTACHABLE_STAGE_NAMES.includes(parsed as (typeof ATTACHABLE_STAGE_NAMES)[number])) {
      return parsed;
    }
    throw new DevtaskError(`Stage ${stage} is not attachable. Attachable stages are ${ATTACHABLE_STAGE_NAMES.join(", ")}.`);
  }
  throw new DevtaskError(`Expected lifecycle stage ${STAGE_NAMES.join(", ")}; got ${stage}`);
}

export function killTaskStageSessions(paths: ReturnType<typeof resolvePaths>, id: string): void {
  if (!isTmuxAvailable()) {
    return;
  }

  for (const stage of STAGE_NAMES) {
    killTmuxSession(stageTmuxSessionName(paths, id, stage));
  }
}

function warnPlainRuntime(): void {
  console.log("Warning: running in plain mode. attach/steer will not be available.");
  console.log("Install tmux and run: devtask config runtime attachable");
}

export function readSteerMessage(root: string, filePath: string | undefined, messageParts: string[]): string {
  if (filePath && messageParts.length > 0) {
    throw new DevtaskError("Use either --file or an inline message, not both");
  }

  if (filePath) {
    const resolved = path.resolve(root, filePath);
    if (!fs.existsSync(resolved)) {
      throw new DevtaskError(`Feedback file does not exist: ${resolved}`);
    }
    const content = fs.readFileSync(resolved, "utf8").trim();
    if (!content) {
      throw new DevtaskError(`Feedback file is empty: ${resolved}`);
    }
    return content;
  }

  const message = messageParts.join(" ").trim();
  if (!message) {
    throw new DevtaskError("No feedback message provided");
  }
  return message;
}

export function steerTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { messageParts: string[]; file?: string; lines: number; messageRoot?: string; stage?: string }
): void {
  const meta = getTask(paths, id);
  const session = options.stage ? resolveLifecycleStageSession(paths, meta, options.stage) : meta.tmuxSession;
  if (!session) {
    throw new DevtaskError(`Task ${id} is not running in an attachable session. Use devtask task run ${id} after configuring attachable runtime.`);
  }
  const message = readSteerMessage(options.messageRoot ?? paths.root, options.file, options.messageParts);
  const result = sendToTmuxSessionWithConfirmation(session, message, { lines: options.lines });
  console.log(result.confirmed ? "Message sent; terminal output changed" : "Message sent; no terminal change observed yet");
  if (result.output.trim()) {
    console.log("");
    console.log(result.output.trimEnd());
  }
}

export function steerWorkPlan(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { messageParts: string[]; file?: string; lines: number }
): void {
  const session = workPlanSessionName(paths, item.id);
  if (!tmuxSessionExists(session)) {
    throw new DevtaskError(`Work item ${item.id} is not running in an attachable planning session. Re-run devtask work plan ${item.id} in attachable mode.`);
  }
  const message = readSteerMessage(paths.root, options.file, options.messageParts);
  const result = sendToTmuxSessionWithConfirmation(session, message, { lines: options.lines });
  console.log(result.confirmed ? "Message sent; terminal output changed" : "Message sent; no terminal change observed yet");
  if (result.output.trim()) {
    console.log("");
    console.log(result.output.trimEnd());
  }
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => displayWidth(row[index] ?? "")))
  );

  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index])).join("  "));
  }
}

export function printWorkspaceTargets(targets: WorkspaceTarget[]): void {
  printTable(
    ["ID", "KIND", "REPO", "SCOPE"],
    targets.map((target) => [target.id, target.kind ?? "-", target.repoPath, target.scope ?? "."])
  );
}

export function printWorkItems(items: WorkItem[]): void {
  printTable(
    ["ID", "STATUS", "SOURCE", "TITLE", "UPDATED"],
    items.map((item) => [
      item.id,
      item.status,
      item.source.type,
      item.source.title,
      item.updatedAt
    ])
  );
}

export async function printWorkSummary(paths: ReturnType<typeof resolveWorkspacePaths>, item: WorkItem): Promise<void> {
  console.log(`Work: ${item.id}`);
  console.log(`Status: ${item.status}`);
  console.log(`Source: ${formatWorkSource(item)}`);
  console.log(`Created: ${item.createdAt}`);
  console.log(`Updated: ${item.updatedAt}`);
  const latestStage = latestWorkStage(readWorkStageLedger(paths, item.id));
  if (latestStage) {
    console.log(`Latest stage: ${latestStage.stage} ${latestStage.status}`);
    if (latestStage.reason) {
      console.log(`Latest reason: ${latestStage.reason}`);
    }
  }

  const planPath = workPlanPath(paths, item.id);
  const graphPath = workGraphPath(paths, item.id);
  const materialization = readWorkMaterialization(paths, item.id);
  console.log("");
  console.log("Artifacts:");
  console.log(`  Plan: ${fs.existsSync(planPath) ? planPath : "-"}`);
  console.log(`  Graph: ${fs.existsSync(graphPath) ? graphPath : "-"}`);
  console.log(`  Approved graph: ${materialization?.approvedGraphPath ?? "-"}`);
  console.log(`  Materialized: ${materialization ? materialization.materializedAt : "-"}`);

  const rows = await buildWorkBoardRows(paths, item);
  console.log("");
  console.log("Targets:");
  printTable(
    ["TARGET", "TASK", "STAGE", "STATUS", "LAST", "CHECK", "REVIEW", "PR", "NEXT"],
    rows.map((row) => [row.target, row.task, row.stage, row.status, row.last, row.check, row.review, row.pr, row.next])
  );

  const prRows = collectWorkPrRows(materialization);
  if (prRows.length > 0) {
    console.log("");
    console.log("Pull Requests:");
    printTable(["TARGET", "TASK", "URL"], prRows);
  }
}

function formatWorkSource(item: WorkItem): string {
  if (item.source.type === "jira") {
    return `${item.source.key} - ${item.source.title} (${item.source.url})`;
  }
  return item.source.title;
}

function collectWorkPrRows(materialization: ReturnType<typeof readWorkMaterialization>): string[][] {
  if (!materialization) {
    return [];
  }

  const rows: string[][] = [];
  for (const task of materialization.tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = getTask(repoPaths, task.taskId);
    if (meta.prUrl) {
      rows.push([task.target, task.taskId, meta.prUrl]);
    }
  }
  return rows;
}

function displayWidth(value: string): number {
  return value.length;
}

export function listTemplateScripts(): string[] {
  const dir = templateScriptsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sh"))
    .map((file) => file.replace(/\.sh$/, ""))
    .sort();
}

export function installTemplateScripts(paths: ReturnType<typeof resolvePaths>, options: { force: boolean }): string[] {
  const targetDir = scriptsDir(paths);
  fs.mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];

  for (const name of listTemplateScripts()) {
    const source = templateScriptPath(name);
    const target = installedScriptPath(paths, name);
    if (fs.existsSync(target) && !options.force) {
      continue;
    }

    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    installed.push(target);
  }

  return installed;
}

export function templateScriptPath(name: string): string {
  assertKnownScriptName(name);
  const filePath = path.join(templateScriptsDir(), `${name}.sh`);
  if (!fs.existsSync(filePath)) {
    throw new DevtaskError(`Unknown script ${name}`);
  }

  return filePath;
}

export function installedScriptPath(paths: ReturnType<typeof resolvePaths>, name: string): string {
  assertKnownScriptName(name);
  return path.join(scriptsDir(paths), `${name}.sh`);
}

function templateScriptsDir(): string {
  return fileURLToPath(new URL("./templates/scripts", import.meta.url));
}

export function assertKnownScriptName(name: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new DevtaskError("Script name may only contain letters, numbers, dots, underscores, and dashes");
  }
}

export function defaultTaskIdForIssue(issueKey: string): string {
  return issueKey.toLowerCase();
}

function getMaterializedWorkTasks(paths: ReturnType<typeof resolvePaths>, item: WorkItem): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  const materialization = readWorkMaterialization(paths, item.id);
  if (!materialization) {
    throw new DevtaskError(`Work item ${item.id} has not been materialized. Run devtask work approve-plan ${item.id} first.`);
  }
  return materialization.tasks;
}

export function selectWorkTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  target?: string
): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  const tasks = getMaterializedWorkTasks(paths, item);
  const selected = target ? tasks.filter((task) => task.target === target) : tasks;
  if (selected.length === 0) {
    throw new DevtaskError(target ? `Work item ${item.id} does not have target ${target}` : `Work item ${item.id} has no materialized tasks`);
  }
  return selected;
}

function getWorkWorkflowUnits(paths: ReturnType<typeof resolvePaths>, item: WorkItem, target?: string): WorkflowUnit[] {
  return selectWorkTasks(paths, item, target).map((task) => ({
    target: task.target,
    taskId: task.taskId,
    repoPath: task.repoPath
  }));
}

export function selectWorkLogTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  target?: string
): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"] {
  return selectWorkTasks(paths, item, target);
}

export function hasMaterializedWorkTasks(paths: ReturnType<typeof resolvePaths>, item: WorkItem): boolean {
  return readWorkMaterialization(paths, item.id) !== null;
}

export function selectOneWorkTask(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  target: string
): NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"][number] {
  return selectWorkTasks(paths, item, target)[0]!;
}

export function resolveRequestedLogStage(stage: LogStage, target: string, taskId: string, boardRows: WorkBoardRow[]): LogStage {
  if (stage !== "current") {
    return stage;
  }
  const row = boardRows.find((candidate) => candidate.target === target && candidate.task === taskId);
  if (row?.stage === "run" || row?.stage === "check" || row?.stage === "review") {
    return row.stage;
  }
  if (row?.stage === "fix") {
    return row.status === "running" || row.status === "passed" || row.status === "failed" ? "fix" : "check";
  }
  return "latest";
}

export async function runWorkWorkflowStage(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  stage: WorkflowStageId,
  target: string | undefined,
  run: (unit: WorkflowUnit) => Promise<{ status: "passed" | "failed" | "running" | "skipped" | "started"; detail: string }>
): Promise<Awaited<ReturnType<typeof runWorkflowStage>>> {
  return runWorkflowStage(DEFAULT_DEV_WORKFLOW, getWorkWorkflowUnits(paths, item, target), {
    stage,
    run
  });
}

export function printWorkflowStageResult(headers: [string, string, string, string], result: Awaited<ReturnType<typeof runWorkflowStage>>): void {
  printTable(
    headers,
    result.results.map((row) => [row.unit.target, row.unit.taskId, row.status, row.detail])
  );
}

export function createFixRequest(paths: ReturnType<typeof resolvePaths>, taskId: string, source: string): ReturnType<typeof createFixRequestFromCheck> {
  const meta = getTask(paths, taskId);
  if (source === "check") {
    return createFixRequestFromCheck(paths, meta);
  }
  throw new DevtaskError(`Fix source ${source} is not supported yet. Supported sources: check`);
}

export async function runWorkRepoPlans(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { refresh?: boolean; attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<Array<{ target: string; taskId: string; repoPath: string; planPath: string; status: string }>> {
  const tasks = getMaterializedWorkTasks(paths, item);
  const results: Array<{ target: string; taskId: string; repoPath: string; planPath: string; status: string }> = [];
  for (const task of tasks) {
    const repoPaths = resolvePaths(task.repoPath);
    const meta = getTask(repoPaths, task.taskId);
    if (!isRepoPlanningAllowed(repoPaths, task.taskId, meta.status)) {
      throw new DevtaskError(`Task ${task.taskId} is ${meta.status}; repo planning is only available before the task runs`);
    }

    if (!options.refresh && meta.status === "planned" && hasTaskPlan(repoPaths, task.taskId)) {
      results.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath: planMarkdownPath(repoPaths, task.taskId),
        status: "existing"
      });
      continue;
    }

    console.log(`${task.target}/${task.taskId}`);
    if (startStageSessionIfRequested(repoPaths, task.taskId, "plan", ["task", "plan", task.taskId, "--plain"], options)) {
      results.push({
        target: task.target,
        taskId: task.taskId,
        repoPath: task.repoPath,
        planPath: planMarkdownPath(repoPaths, task.taskId),
        status: "started"
      });
      continue;
    }
    await planTask(repoPaths, task.taskId);
    results.push({
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      planPath: planMarkdownPath(repoPaths, task.taskId),
      status: "planned"
    });
  }
  return results;
}

function isRepoPlanningAllowed(paths: ReturnType<typeof resolvePaths>, taskId: string, status: ReturnType<typeof getTask>["status"]): boolean {
  if (["created", "planned", "blocked"].includes(status)) {
    return true;
  }
  if (status !== "failed") {
    return false;
  }

  const stages = readStageLedger(paths, taskId).stages;
  return stages.plan?.status === "failed" && !stages.run;
}

export async function runReadyWorkTasks(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean }
): Promise<void> {
  const plan = planWorkRun(paths, item);
  for (const task of plan.skipped) {
    console.log(`${task.target}/${task.taskId}: skipped (${task.reason})`);
  }
  const result = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, plan.ready, {
    stage: "run",
    run: async (task) => {
      const repoPaths = resolvePaths(task.repoPath);
      const runtime = resolveRunRuntime(repoPaths, options);
      printStartedWorker(`${task.target}/${task.taskId}`, startWorker(repoPaths, task.taskId, runtime), "Running", workTaskRuntimeCommands(item.id, task.target));
      return { status: "started", detail: "worker started" };
    }
  });
  if (workflowStageFailed(result)) {
    printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], result);
    throw new DevtaskError(`Work run ${item.id} failed to start one or more ready tasks.`);
  }
  if (plan.ready.length === 0 && plan.skipped.length === 0) {
    console.log(`No materialized tasks for work item ${item.id}`);
  }
}

function workTaskRuntimeCommands(workId: string, target: string): { attach: string; steer: string } {
  return {
    attach: `devtask work attach ${shellQuote(workId)} --target ${shellQuote(target)}`,
    steer: `devtask work steer ${shellQuote(workId)} --target ${shellQuote(target)} "message"`
  };
}

export async function followWorkRun(
  paths: ReturnType<typeof resolvePaths>,
  item: WorkItem,
  options: { attachable?: boolean; tmux?: boolean; plain?: boolean; poll: number }
): Promise<void> {
  const intervalMs = options.poll * 1000;
  const announcedWaiting = new Set<string>();
  console.log(`Following work run ${item.id}`);

  while (true) {
    throwIfWorkRunFailed(paths, item);
    const plan = planWorkRun(paths, item);
    const startResult = await runWorkflowStage(DEFAULT_DEV_WORKFLOW, plan.ready, {
      stage: "run",
      run: async (task) => {
        const repoPaths = resolvePaths(task.repoPath);
        const runtime = resolveRunRuntime(repoPaths, options);
        printStartedWorker(`${task.target}/${task.taskId}`, startWorker(repoPaths, task.taskId, runtime), "Running", workTaskRuntimeCommands(item.id, task.target));
        return { status: "started", detail: "worker started" };
      }
    });
    if (workflowStageFailed(startResult)) {
      printWorkflowStageResult(["TARGET", "TASK", "STATUS", "DETAIL"], startResult);
      throw new DevtaskError(`Work run ${item.id} failed to start one or more ready tasks.`);
    }

    for (const task of plan.skipped) {
      const key = `${task.target}/${task.taskId}:${task.reason}`;
      if (!announcedWaiting.has(key)) {
        announcedWaiting.add(key);
        console.log(`${task.target}/${task.taskId}: waiting (${task.reason})`);
      }
    }

    if (isWorkRunComplete(paths, item)) {
      console.log(`Work run ${item.id} complete`);
      return;
    }

    if (plan.ready.length === 0 && !hasRunningMaterializedTask(paths, item)) {
      throw new DevtaskError(`Work run ${item.id} cannot advance. Inspect with devtask work board ${item.id}.`);
    }

    await sleep(intervalMs);
  }
}

function throwIfWorkRunFailed(paths: ReturnType<typeof resolvePaths>, item: WorkItem): void {
  const failed = getMaterializedWorkTasks(paths, item)
    .map((task) => ({ task, meta: getTask(resolvePaths(task.repoPath), task.taskId) }))
    .find(({ meta }) => meta.status === "failed" || meta.status === "blocked" || meta.status === "cancelled");
  if (failed) {
    throw new DevtaskError(`${failed.task.target}/${failed.task.taskId} is ${failed.meta.status}. Inspect with devtask work board ${item.id}.`);
  }
}

function isWorkRunComplete(paths: ReturnType<typeof resolvePaths>, item: WorkItem): boolean {
  const tasks = getMaterializedWorkTasks(paths, item);
  return tasks.length > 0 && tasks.every((task) => isWorkTaskRunComplete(resolvePaths(task.repoPath), task.taskId));
}

function hasRunningMaterializedTask(paths: ReturnType<typeof resolvePaths>, item: WorkItem): boolean {
  return getMaterializedWorkTasks(paths, item).some((task) => {
    const meta = getTask(resolvePaths(task.repoPath), task.taskId);
    return meta.status === "running" || isProcessAlive(meta.supervisorPid);
  });
}

export function existingWorkPlanArtifacts(paths: ReturnType<typeof resolvePaths>, id: string): boolean {
  return fs.existsSync(workPlanPath(paths, id)) && fs.existsSync(workGraphPath(paths, id));
}

export function printExistingWorkPlan(paths: ReturnType<typeof resolvePaths>, id: string): void {
  console.log(`Work item ${id} already has a plan.`);
  console.log(`Plan: ${workPlanPath(paths, id)}`);
  console.log(`Graph: ${workGraphPath(paths, id)}`);
  console.log("");
  console.log(`Next: devtask work approve-plan ${shellQuote(id)}`);
  console.log(`Use --refresh to regenerate the plan before approval.`);
}

export function printMaterializedWorkPlan(paths: ReturnType<typeof resolvePaths>, id: string, taskCount: number): void {
  console.log(`Work item ${id} has already been materialized.`);
  console.log(`Plan: ${workPlanPath(paths, id)}`);
  console.log(`Graph: ${workGraphPath(paths, id)}`);
  console.log(`Materialized tasks: ${taskCount}`);
  console.log("");
  console.log(`Next: devtask work board ${shellQuote(id)}`);
  console.log(`Use cleanup before replanning from scratch.`);
}

export function printWorkLog(
  target: string,
  repoPath: string,
  taskId: string,
  options: { stage: LogStage; lines: number; follow: boolean }
): void {
  printStageTaskLog(`${target}/${taskId}`, repoPath, taskId, options);
}

export function printWorkPlanLog(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  item: WorkItem,
  options: { lines: number; follow: boolean }
): void {
  const ledger = readWorkStageLedger(paths, item.id);
  const artifactPath = ledger.stages.plan?.artifacts.find((artifact) => artifact.endsWith(".md") && !artifact.endsWith(".prompt.md"));
  const record = readLatestWorkPlanRecord(paths, item.id);
  const logPath = artifactPath ?? record?.outputPath ?? latestWorkPlannerOutputPath(paths, item.id);
  if (!logPath) {
    console.log(`Work ${item.id}: no planning logs`);
    return;
  }

  console.log(`Work ${item.id} plan`);
  console.log(`Log: ${logPath}`);
  if (options.follow) {
    followFile(logPath, options.lines);
    return;
  }
  console.log(tailFile(logPath, options.lines));
}

export function workPlanSessionName(paths: ReturnType<typeof resolveWorkspacePaths>, id: string): string {
  return `${tmuxSessionName(paths, id)}-work-plan`;
}

function printMaterializedTaskLog(
  label: string,
  repoPath: string,
  taskId: string,
  options: { lines: number; follow: boolean }
): void {
  const repoPaths = resolvePaths(repoPath);
  getTask(repoPaths, taskId);
  const logPath = readLatestLogPath(repoPaths, taskId);
  if (!logPath) {
    console.log(`${label}: no logs`);
    return;
  }

  console.log(label);
  console.log(`Log: ${logPath}`);
  if (options.follow) {
    followFile(logPath, options.lines);
    return;
  }

  console.log(tailFile(logPath, options.lines));
}

function printStageTaskLog(
  label: string,
  repoPath: string,
  taskId: string,
  options: { stage: LogStage; lines: number; follow: boolean }
): void {
  const repoPaths = resolvePaths(repoPath);
  const review = readTaskLogArtifacts(repoPaths, taskId);
  const stage = options.stage === "latest" || options.stage === "current" ? latestLogStage(review) : options.stage;
  if (!stage) {
    console.log(`${label}: no stage logs`);
    return;
  }

  if (stage === "run") {
    if (!review.latestRun) {
      console.log(`${label}: no run logs`);
      return;
    }
    printFileLog(`${label} run`, review.latestRun.logPath, options);
    return;
  }

  if (stage === "fix") {
    const logPath = latestFixLogPath(repoPaths, taskId);
    if (!logPath) {
      console.log(`${label}: no fix logs`);
      return;
    }
    printFileLog(`${label} fix`, logPath, options);
    return;
  }

  if (stage === "review") {
    if (!review.latestReviewAgent) {
      console.log(`${label}: no review logs`);
      return;
    }
    printFileLog(`${label} review`, review.latestReviewAgent.outputPath, options);
    return;
  }

  if (!review.latestVerification) {
    console.log(`${label}: no check logs`);
    return;
  }
  if (options.follow) {
    console.log(`${label} check`);
    console.log("Check output is complete; printing the latest captured verification output instead of following.");
    printVerificationOutput(review.latestVerification, options.lines);
    return;
  }

  console.log(`${label} check`);
  printVerificationOutput(review.latestVerification, options.lines);
}

function printFileLog(label: string, filePath: string, options: { lines: number; follow: boolean }): void {
  if (!fs.existsSync(filePath)) {
    console.log(`${label}: missing log file ${filePath}`);
    return;
  }

  console.log(label);
  console.log(`Log: ${filePath}`);
  if (options.follow) {
    followFile(filePath, options.lines);
    return;
  }
  console.log(tailFile(filePath, options.lines));
}

function latestWorkPlannerOutputPath(paths: ReturnType<typeof resolveWorkspacePaths>, id: string): string | null {
  const runsDir = workPlansDir(paths, id);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const latest = fs
    .readdirSync(runsDir)
    .filter((file) => file.endsWith(".md") && !file.endsWith(".prompt.md"))
    .sort()
    .at(-1);
  return latest ? path.join(runsDir, latest) : null;
}

function latestWorkStage(ledger: ReturnType<typeof readWorkStageLedger>): WorkStageContract | null {
  return WORK_STAGE_NAMES.map((stage) => ledger.stages[stage])
    .filter((stage): stage is WorkStageContract => Boolean(stage))
    .sort((a, b) => {
      const aTime = Date.parse(a.finishedAt ?? a.startedAt ?? "");
      const bTime = Date.parse(b.finishedAt ?? b.startedAt ?? "");
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    })
    .at(0) ?? null;
}

interface TaskLogArtifacts {
  latestRun: ReturnType<typeof readLatestRun>;
  latestFixFinishedAt: string | null;
  latestVerification: VerificationRecord | null;
  latestReviewAgent: ReviewAgentRecord | null;
}

function readTaskLogArtifacts(repoPaths: ReturnType<typeof resolvePaths>, taskId: string): TaskLogArtifacts {
  getTask(repoPaths, taskId);
  return {
    latestRun: readLatestRun(repoPaths, taskId),
    latestFixFinishedAt: readStageLedger(repoPaths, taskId).stages.fix?.finishedAt ?? null,
    latestVerification: readLatestVerification(repoPaths, taskId),
    latestReviewAgent: readLatestReviewAgent(repoPaths, taskId)
  };
}

function latestFixLogPath(paths: ReturnType<typeof resolvePaths>, taskId: string): string | null {
  return readStageLedger(paths, taskId).stages.fix?.artifacts.find((artifact) => artifact.endsWith(".log")) ?? null;
}

function latestLogStage(review: TaskLogArtifacts): Exclude<LogStage, "current" | "latest"> | null {
  const candidates: Array<{ stage: Exclude<LogStage, "current" | "latest">; at: string }> = [];
  if (review.latestRun) {
    candidates.push({ stage: "run", at: review.latestRun.finishedAt });
  }
  if (review.latestFixFinishedAt) {
    candidates.push({ stage: "fix", at: review.latestFixFinishedAt });
  }
  if (review.latestVerification) {
    candidates.push({ stage: "check", at: review.latestVerification.finishedAt });
  }
  if (review.latestReviewAgent) {
    candidates.push({ stage: "review", at: review.latestReviewAgent.finishedAt });
  }
  candidates.sort((a, b) => a.at.localeCompare(b.at));
  return candidates.at(-1)?.stage ?? null;
}

function printVerificationOutput(verification: VerificationRecord, lines: number): void {
  console.log(`Status: ${verification.status}`);
  console.log(`Started: ${verification.startedAt}`);
  console.log(`Finished: ${verification.finishedAt}`);
  console.log("");
  console.log("Steps:");
  for (const step of verification.steps) {
    console.log(`  ${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
  }
  const output = renderVerificationOutput(verification);
  if (output) {
    console.log("");
    console.log(tailText(output, lines));
  }
}

function renderVerificationOutput(verification: VerificationRecord): string {
  return verification.steps
    .map((step) =>
      [
        `${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`,
        step.stdout ? `stdout:\n${step.stdout.trimEnd()}` : "",
        step.stderr ? `stderr:\n${step.stderr.trimEnd()}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

export function markTask(paths: ReturnType<typeof resolvePaths>, id: string, status: ReturnType<typeof parseManualStatus>): void {
  const meta = getTask(paths, id);
  assertCanMark(meta, status);

  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    status,
    supervisorPid: null,
    childPid: null,
    tmuxSession: status === "cancelled" ? null : meta.tmuxSession,
    updatedAt: new Date().toISOString()
  });
}

export async function approveTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { force: boolean }
): Promise<string> {
  const meta = getTask(paths, id);
  assertCanMark(meta, "approved");
  const issues = await collectApprovalIssues(paths, meta);
  if (issues.length > 0 && !options.force) {
    throw new DevtaskError(
      `Task ${id} is not ready for approval:\n${issues.map((issue) => `  - ${issue}`).join("\n")}\nUse --force to approve anyway.`
    );
  }

  markTask(paths, id, "approved");
  recordStage(paths, id, "approve", {
    status: "passed",
    input: {
      force: options.force,
      issues
    },
    output: {
      approved: true,
      forced: issues.length > 0
    },
    reason: issues.length > 0 ? `forced: ${issues.join("; ")}` : null
  });
  return issues.length > 0 ? `forced: ${issues.join("; ")}` : "policy passed";
}

async function collectApprovalIssues(paths: ReturnType<typeof resolvePaths>, meta: ReturnType<typeof getTask>): Promise<string[]> {
  const issues: string[] = [];
  const config = readConfig(paths);
  const review = await buildTaskReview(paths, meta);

  if (config.verify.length > 0) {
    if (!review.latestVerification) {
      issues.push("checks missing");
    } else if (review.latestVerification.status !== "passed") {
      issues.push(`checks ${review.latestVerification.status}`);
    }
  }

  if (!review.latestReviewAgent) {
    issues.push("review missing");
  } else if (review.latestReviewAgent.status !== "passed") {
    issues.push(`review ${review.latestReviewAgent.status}`);
  }

  // TODO(stage-contract): add a real content-change baseline before enforcing stale artifact checks.
  // `meta.updatedAt` tracks metadata updates, not necessarily code/worktree changes.
  return issues;
}

export function normalizeCleanupOptions(
  options: CleanupOptions & { keepWorktrees?: boolean; keepMetadata?: boolean }
): CleanupOptions {
  return {
    dryRun: options.dryRun === true,
    force: options.force === true,
    keepWorktree: options.keepWorktree === true || options.keepWorktrees === true,
    keepMetadata: options.keepMetadata === true
  };
}

export function printCleanupPlan(label: string, plan: CleanupPlan): void {
  console.log(label);
  for (const action of plan.actions) {
    console.log(`  PLAN ${action}`);
  }
  for (const blocker of plan.blockers) {
    console.log(`  BLOCKED ${blocker}`);
  }
}

export function printWorkPrPreflight(
  rows: Array<{ task: NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"][number]; meta: ReturnType<typeof getTask>; preflight: ScmPreflight }>,
  mode: string
): void {
  console.log("Preflight:");
  printTable(
    ["TARGET", "TASK", "STATUS", "LIFECYCLE", "PROVIDER", "ACCESS", "CLEAN", "COMMITS", "MODE", "PR"],
    rows.map(({ task, meta, preflight }) => [
      task.target,
      task.taskId,
      meta.status,
      isWorkPrLifecycleReady(meta) ? "ok" : "blocked",
      preflight.provider,
      preflight.access,
      preflight.clean ? "ok" : "dirty",
      preflight.commits > 0 ? "yes" : "no",
      mode === "draft" && !preflight.draftSupported ? "unsupported" : mode,
      meta.prUrl ? "open" : "-"
    ])
  );
  const details = rows.filter(({ preflight }) => preflight.accessDetail);
  if (details.length > 0) {
    console.log("");
    console.log("Preflight details:");
    for (const { task, preflight } of details) {
      console.log(`${task.target}/${task.taskId}: ${preflight.accessDetail}`);
    }
  }
  console.log("");
}

function isPrPreflightReady(meta: ReturnType<typeof getTask>, preflight: ScmPreflight, draft: boolean): boolean {
  if (meta.status === "pr-open" && meta.prUrl) {
    return true;
  }
  return preflight.access === "ok" && preflight.clean && preflight.commits > 0 && (!draft || preflight.draftSupported);
}

function isWorkPrPreflightReady(meta: ReturnType<typeof getTask>, preflight: ScmPreflight, draft: boolean): boolean {
  if (meta.status === "pr-open" && meta.prUrl) {
    return true;
  }
  return isWorkPrLifecycleReady(meta) && isPrPreflightReady(meta, preflight, draft);
}

function isWorkPrLifecycleReady(meta: ReturnType<typeof getTask>): boolean {
  return meta.status === "approved" || meta.status === "ci-failed" || (meta.status === "pr-open" && Boolean(meta.prUrl));
}

export function workPrPreflightBlockers(
  workId: string,
  rows: Array<{ task: NonNullable<ReturnType<typeof readWorkMaterialization>>["tasks"][number]; meta: ReturnType<typeof getTask>; preflight: ScmPreflight }>,
  draft: boolean
): string[] {
  return rows.flatMap(({ task, meta, preflight }) =>
    prPreflightBlockers(`${task.target}/${task.taskId}`, meta, preflight, draft, isWorkPrLifecycleReady(meta), {
      commitCommand: `devtask work commit ${shellQuote(workId)} --target ${shellQuote(task.target)}`
    })
  );
}

function prPreflightBlockers(
  label: string,
  meta: ReturnType<typeof getTask>,
  preflight: ScmPreflight,
  draft: boolean,
  lifecycleReady: boolean,
  commands: { commitCommand: string }
): string[] {
  if (meta.status === "pr-open" && meta.prUrl) {
    return [];
  }

  const blockers: string[] = [];
  if (!lifecycleReady) {
    blockers.push(`${label}: task is ${meta.status}; approve it before opening a PR`);
  }
  if (preflight.access !== "ok") {
    blockers.push(`${label}: source provider access failed${preflight.accessDetail ? ` (${preflight.accessDetail})` : ""}`);
  }
  if (!preflight.clean) {
    blockers.push(`${label}: worktree has uncommitted changes; run ${commands.commitCommand}`);
  }
  if (preflight.commits === 0) {
    blockers.push(`${label}: branch has no commits to publish; run ${commands.commitCommand}`);
  }
  if (draft && !preflight.draftSupported) {
    blockers.push(`${label}: draft PRs are not supported by ${preflight.provider}; rerun with --ready`);
  }
  return blockers;
}

export function printPrPreflightBlockers(blockers: string[]): void {
  console.log("Blocked:");
  for (const blocker of blockers) {
    console.log(`- ${blocker}`);
  }
}

export async function planTask(paths: ReturnType<typeof resolvePaths>, id: string): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before planning`);
  }
  if (["approved", "pr-open", "ci-running", "ci-failed", "ci-passed", "done", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${id} is ${meta.status}; planning is only available before approval and publishing`);
  }

  const config = readConfig(paths);
  const record = await runStage(paths, id, "plan", {
    input: {
      taskPath: meta.taskPath,
      worktreePath: meta.worktreePath,
      model: meta.model ?? config.codex.model
    },
    artifacts: [planMarkdownPath(paths, id)]
  }, async () => {
    console.log(`Running planning agent in ${meta.worktreePath}`);
    const planRecord = await runPlanAgent(paths, meta, {
      model: meta.model ?? config.codex.model,
      fullAuto: config.codex.fullAuto,
      onStart: (start) => {
        console.log(`Prompt: ${start.promptPath}`);
        console.log(`Plan: ${start.planPath}`);
        console.log(`Output: ${start.outputPath}`);
        console.log(`Command: ${start.command}`);
      },
      onStdout: (chunk) => {
        process.stdout.write(chunk);
      },
      onStderr: (chunk) => {
        process.stderr.write(chunk);
      }
    });
    return {
      result: planRecord,
      final: {
        status: planRecord.worktreeChanged ? "failed" : planRecord.status === "planned" ? "passed" : planRecord.status,
        output: {
          planId: planRecord.planId,
          exitCode: planRecord.exitCode,
          worktreeChanged: planRecord.worktreeChanged,
          planPath: planRecord.planPath,
          outputPath: planRecord.outputPath
        },
        artifacts: [planRecord.planPath, planRecord.outputPath],
        reason: planRecord.worktreeChanged ? "planning changed the task worktree" : planRecord.status === "failed" ? "planning agent failed" : null
      }
    };
  });
  console.log(`Plan: ${record.status}`);
  console.log(`File: ${record.planPath}`);
  if (record.worktreeChanged) {
    throw new DevtaskError("Planning changed the task worktree. Revert those changes or inspect them before continuing.");
  }
  if (record.status === "failed") {
    process.exit(1);
  }
}

export async function checkTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { exitOnFailure: boolean; verbose?: boolean }
): Promise<VerificationRecord> {
  const meta = getTask(paths, id);
  assertCheckReady(paths, meta);

  const config = readConfig(paths);
  if (config.verify.length === 0) {
    throw new DevtaskError("No check commands configured. Use devtask config check <command...>");
  }

  if (options.verbose !== false) {
    console.log(`Running ${config.verify.length} check command${config.verify.length === 1 ? "" : "s"} in ${meta.worktreePath}`);
  }
  const record = await runStage(paths, id, "check", {
    input: {
      commands: config.verify,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    const verificationRecord = await runVerification(paths, meta, config.verify, {
      onStepStart: (command, index, total) => {
        if (options.verbose !== false) {
          console.log(`[${index}/${total}] ${command}`);
        }
      }
    });
    return {
      result: verificationRecord,
      final: {
        status: verificationRecord.status,
        output: {
          verificationId: verificationRecord.verificationId,
          steps: verificationRecord.steps.map((step) => ({
            command: step.command,
            exitCode: step.exitCode
          }))
        },
        reason: verificationRecord.status === "failed" ? "one or more check commands failed" : null
      }
    };
  });
  if (options.verbose === false) {
    return record;
  }

  console.log(`Check: ${record.status}`);
  for (const step of record.steps) {
    console.log(`${step.exitCode === 0 ? "PASS" : "FAIL"} ${step.command}`);
    if (step.exitCode !== 0) {
      if (step.stdout.trim()) console.log(step.stdout.trim());
      if (step.stderr.trim()) console.error(step.stderr.trim());
      if (options.exitOnFailure) {
        process.exit(1);
      }
    }
  }
  return record;
}

export async function reviewTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { exitOnFindings: boolean }
): Promise<void> {
  const meta = getTask(paths, id);
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${id} is running; stop it before review`);
  }

  const config = readConfig(paths);
  assertReviewReady(paths, meta, config);
  console.log(`Running review agent in ${meta.worktreePath}`);
  const record = await runStage(paths, id, "review", {
    input: {
      worktreePath: meta.worktreePath,
      model: meta.model ?? config.codex.model,
      planPath: planMarkdownPath(paths, id)
    }
  }, async () => {
    const reviewRecord = await runReviewAgent(paths, meta, {
      model: meta.model ?? config.codex.model,
      fullAuto: config.codex.fullAuto,
      onStart: (start) => {
        console.log(`Prompt: ${start.promptPath}`);
        console.log(`Output: ${start.outputPath}`);
        console.log(`Command: ${start.command}`);
      },
      onStdout: (chunk) => {
        process.stdout.write(chunk);
      },
      onStderr: (chunk) => {
        process.stderr.write(chunk);
      }
    });
    return {
      result: reviewRecord,
      final: {
        status: reviewRecord.status,
        output: {
          reviewId: reviewRecord.reviewId,
          exitCode: reviewRecord.exitCode,
          outputPath: reviewRecord.outputPath
        },
        artifacts: [reviewRecord.outputPath],
        reason: reviewRecord.status === "passed" ? null : `review agent ${reviewRecord.status}`
      }
    };
  });
  console.log(`Review agent: ${record.status}`);
  console.log(`Output: ${record.outputPath}`);
  if (record.status !== "passed" && options.exitOnFindings) {
    process.exit(record.exitCode === 0 ? 2 : 1);
  }
}

export async function openPrForTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: PrOptions
): Promise<string> {
  const draft = resolvePrDraftMode(options);
  const meta = getTask(paths, id);
  assertPrReady(meta);

  const uncommitted = await hasUncommittedChanges(meta.worktreePath);
  if (uncommitted) {
    throw new DevtaskError(
      `Task ${id} has uncommitted changes. Run devtask task commit ${id}, or ask the agent to continue and commit its work.`
    );
  }
  const commitCount = await countBranchCommits(meta.worktreePath);
  if (commitCount === 0) {
    throw new DevtaskError(`Task ${id} has no branch commits to publish. Run devtask task commit ${id} first.`);
  }

  const prUrl = await runStage(paths, id, "pr", {
    input: {
      title: options.title ?? meta.id,
      draft,
      commitCount,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    const openedPrUrl = await createPullRequest(meta, {
      title: options.title ?? meta.id,
      body: options.body ?? defaultPrBody(meta),
      draft
    });

    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      status: "pr-open",
      prUrl: openedPrUrl,
      updatedAt: new Date().toISOString()
    });
    return {
      result: openedPrUrl,
      final: {
        status: "passed",
        output: {
          prUrl: openedPrUrl,
          draft
        }
      }
    };
  });
  console.log(prUrl);
  return prUrl;
}

export async function commitTask(
  paths: ReturnType<typeof resolvePaths>,
  id: string,
  options: { message?: string } = {}
): Promise<void> {
  const meta = getTask(paths, id);
  assertCommitReady(paths, meta);

  await runCommandOrThrow("git", ["add", "-A"], { cwd: meta.worktreePath });
  const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: meta.worktreePath });
  if (staged.exitCode === 0) {
    recordStage(paths, id, "commit", {
      status: "skipped",
      input: {
        worktreePath: meta.worktreePath
      },
      reason: "no staged changes"
    });
    console.log(`No changes to commit for ${id}`);
    return;
  }

  const message = options.message ?? meta.id;
  await runStage(paths, id, "commit", {
    input: {
      message,
      worktreePath: meta.worktreePath
    }
  }, async () => {
    await runCommandOrThrow("git", ["commit", "-m", message], { cwd: meta.worktreePath });
    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      updatedAt: new Date().toISOString()
    });
    return {
      result: undefined,
      final: {
        status: "passed",
        output: {
          message
        }
      }
    };
  });
  console.log(`Committed ${id}`);
}

export async function checkCiForTask(paths: ReturnType<typeof resolvePaths>, id: string): Promise<void> {
  const meta = getTask(paths, id);
  assertCiReady(meta);

  const result = await checkProviderCi(meta.worktreePath, meta.prUrl, meta.branch);
  console.log(`${result.provider}: ${result.detail}`);
  if (result.url) {
    console.log(result.url);
  }

  const status = taskStatusFromCiResult(result.status);
  recordStage(paths, id, "ci", {
    status: stageStatusFromCiResult(result.status),
    input: {
      prUrl: meta.prUrl,
      branch: meta.branch
    },
    output: {
      provider: result.provider,
      detail: result.detail,
      url: result.url
    },
    reason: ciStageReason(result.status)
  });
  writeTaskMeta(taskMetaPath(paths, id), {
    ...meta,
    status,
    updatedAt: new Date().toISOString()
  });
}

function taskStatusFromCiResult(status: Awaited<ReturnType<typeof checkProviderCi>>["status"]): ReturnType<typeof getTask>["status"] {
  if (status === "passed") {
    return "ci-passed";
  }
  if (status === "failed") {
    return "ci-failed";
  }
  if (status === "running") {
    return "ci-running";
  }
  return "pr-open";
}

export function workflowCiStatus(status: ReturnType<typeof getTask>["status"]): "passed" | "failed" | "running" | "skipped" {
  if (status === "ci-passed") {
    return "passed";
  }
  if (status === "ci-failed") {
    return "failed";
  }
  if (status === "ci-running") {
    return "running";
  }
  return "skipped";
}

function stageStatusFromCiResult(status: Awaited<ReturnType<typeof checkProviderCi>>["status"]): "passed" | "failed" | "running" | "skipped" {
  return status === "unknown" ? "skipped" : status;
}

function ciStageReason(status: Awaited<ReturnType<typeof checkProviderCi>>["status"]): string | null {
  if (status === "passed") {
    return null;
  }
  if (status === "failed") {
    return "CI check failed";
  }
  if (status === "running") {
    return "CI is still running";
  }
  return "CI status is unavailable";
}

export function startWorker(paths: ReturnType<typeof resolvePaths>, id: string, options: { tmux?: boolean; fix?: boolean } = {}): StartedWorker {
  const meta = getTask(paths, id);
  if (options.fix) {
    assertFixReady(meta);
  } else {
    assertRunReady(meta);
  }
  if (isProcessAlive(meta.supervisorPid)) {
    throw new DevtaskError(`Task ${id} is already supervised by PID ${meta.supervisorPid}`);
  }

  const next = {
    ...meta,
    status: "running" as const,
    supervisorPid: null,
    childPid: null,
    tmuxSession: options.tmux ? tmuxSessionName(paths, id) : null,
    failCount: 0,
    updatedAt: new Date().toISOString()
  };
  writeTaskMeta(taskMetaPath(paths, id), next);
  const runInput = {
    command: meta.command,
    worktreePath: meta.worktreePath,
    mode: options.tmux ? "attachable" : "plain",
    tmuxSession: next.tmuxSession
  };
  recordStage(paths, id, "run", {
    status: "running",
    input: runInput
  });

  const rollbackStartFailure = (error: unknown): never => {
    writeTaskMeta(taskMetaPath(paths, id), {
      ...meta,
      updatedAt: new Date().toISOString()
    });
    recordStage(paths, id, "run", {
      status: "failed",
      input: runInput,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  };

  const workerPath = fileURLToPath(new URL("./bin/devtask-worker.js", import.meta.url));
  const workerCommand = [process.execPath, workerPath, id, "--root", paths.root];

  if (options.tmux) {
    const session = next.tmuxSession;
    if (!session) {
      return rollbackStartFailure(new DevtaskError("Unable to derive tmux session name"));
    }
    const startupLog = createStartupLogPath(paths, id);
    try {
      startTmuxSession(session, tmuxWrappedWorkerCommand(workerCommand, startupLog), paths.root);
      if (!waitForTmuxSession(session)) {
        return rollbackStartFailure(buildTmuxStartupFailure(session, startupLog));
      }
    } catch (error) {
      rollbackStartFailure(error);
    }
    return { pid: null, tmuxSession: session, startupLogPath: startupLog };
  }

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [workerPath, id, "--root", paths.root], {
      cwd: paths.root,
      detached: true,
      stdio: "ignore"
    });
  } catch (error) {
    rollbackStartFailure(error);
  }

  const startedChild = child;
  if (!startedChild || startedChild.pid === undefined) {
    return rollbackStartFailure(new DevtaskError("Failed to start worker process"));
  }
  const childPid: number = startedChild.pid;
  startedChild.once("error", (error) => {
    const current = getTask(paths, id);
    if (current.status === "running" && current.supervisorPid === childPid) {
      writeTaskMeta(taskMetaPath(paths, id), {
        ...meta,
        updatedAt: new Date().toISOString()
      });
    }
    recordStage(paths, id, "run", {
      status: "failed",
      input: runInput,
      reason: error.message
    });
  });
  startedChild.unref();

  writeTaskMeta(taskMetaPath(paths, id), {
    ...next,
    supervisorPid: childPid,
    tmuxSession: null,
    updatedAt: new Date().toISOString()
  });

  return { pid: childPid, tmuxSession: null };
}

function createStartupLogPath(paths: ReturnType<typeof resolvePaths>, id: string): string {
  const dir = startupDir(paths, id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}.log`);
}

function tmuxWrappedWorkerCommand(workerCommand: string[], startupLog: string): string[] {
  const quotedCommand = workerCommand.map(shellQuote).join(" ");
  const quotedLog = shellQuote(startupLog);
  return [
    "/bin/zsh",
    "-lc",
    `exec ${quotedCommand} > ${quotedLog} 2>&1`
  ];
}

function buildTmuxStartupFailure(session: string, startupLog: string): DevtaskError {
  let detail = `tmux worker session ${session} exited during startup.`;
  if (fs.existsSync(startupLog)) {
    const output = fs.readFileSync(startupLog, "utf8").trim();
    if (output) {
      const tail = output.split("\n").slice(-20).join("\n");
      detail = `${detail} Startup log: ${startupLog}\n${tail}`;
    } else {
      detail = `${detail} Startup log: ${startupLog}`;
    }
  }
  return new DevtaskError(detail);
}

function assertFixReady(meta: ReturnType<typeof getTask>): void {
  if (meta.status === "running") {
    throw new DevtaskError(`Task ${meta.id} is already running.`);
  }
  if (["approved", "pr-open", "ci-running", "ci-passed", "cancelled"].includes(meta.status)) {
    throw new DevtaskError(`Task ${meta.id} is ${meta.status} and cannot be fixed.`);
  }
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DevtaskError("Expected a positive integer");
  }
  return parsed;
}

export function parseLogStage(value: string): LogStage {
  if (value === "current" || value === "latest" || value === "run" || value === "check" || value === "fix" || value === "review") {
    return value;
  }
  throw new DevtaskError(`Expected log stage current, latest, run, check, fix, or review; got ${value}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tailFile(filePath: string, lineCount: number): string {
  const content = fs.readFileSync(filePath, "utf8");
  return tailText(content, lineCount);
}

function tailText(content: string, lineCount: number): string {
  return content.split("\n").slice(-lineCount).join("\n");
}

export function followFile(filePath: string, lineCount: number): void {
  const child = spawn("tail", ["-n", String(lineCount), "-f", filePath], {
    stdio: "inherit"
  });

  child.once("error", (error) => {
    printError(new DevtaskError(`Failed to follow log: ${error.message}`));
  });
}

async function createPullRequest(
  meta: ReturnType<typeof getTask>,
  options: { title: string; body: string; draft: boolean }
): Promise<string> {
  return createProviderPullRequest(meta.worktreePath, {
    ...options,
    branch: meta.branch
  });
}

export function resolvePrDraftMode(options: PrOptions): boolean {
  if (options.ready && options.draft) {
    throw new DevtaskError("Use either --ready or --draft, not both");
  }
  return options.ready !== true;
}

function defaultPrBody(meta: ReturnType<typeof getTask>): string {
  return [
    `Task: ${meta.id}`,
    "",
    `Branch: ${meta.branch}`,
    `Worktree: ${meta.worktreePath}`,
    "",
    "Created by devtask. Review the task record locally with:",
    "",
    `    devtask task inspect ${meta.id}`
  ].join("\n");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
