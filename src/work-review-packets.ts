import fs from "node:fs";
import path from "node:path";
import { runCommand, runCommandOrThrow } from "./process-runner.js";
import { readLatestReviewAgent } from "./review-agent.js";
import { readStageLedger } from "./stage-contracts.js";
import { readLatestVerification } from "./verification.js";
import type { DevtaskPaths } from "./paths.js";
import {
  planMarkdownPath,
  workItemApprovedGraphPath,
  workItemMaterializationPath
} from "./paths.js";
import { getTask } from "./task-store.js";
import { readWorkGraph, readWorkMaterialization } from "./work-materializer.js";
import { workGraphPath, workPlanPath } from "./work-planner.js";
import type { WorkItem } from "./work-store.js";
import { listWorkspaceTargets } from "./workspace-targets.js";

export interface ReviewPacketMessage {
  level: "warning" | "blocker";
  message: string;
}

export interface WorkSpecReviewTask {
  id: string;
  target: string;
  targetExists: boolean;
  owns: string[];
  dependencies: string[];
  materializedTaskId: string | null;
  repoPlanPath: string | null;
  repoPlanExists: boolean;
}

export interface WorkSpecReviewPacket {
  workId: string;
  title: string;
  source: {
    type: string;
    label: string;
    artifact: string;
    url: string | null;
  };
  planPath: string;
  planExists: boolean;
  graphPath: string;
  graphExists: boolean;
  approvedGraphPath: string;
  approvedGraphExists: boolean;
  materializationPath: string;
  materialized: boolean;
  tasks: WorkSpecReviewTask[];
  validation: string[];
  openQuestions: string[];
  messages: ReviewPacketMessage[];
}

export interface WorkExecReviewTask {
  target: string;
  taskId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string | null;
  headSha: string | null;
  commitsAhead: number | null;
  committedChangedFiles: string[];
  dirtyTrackedFiles: string[];
  untrackedFiles: string[];
  checkStatus: string;
  agentReviewStatus: string;
  taskStatus: string;
  prUrl: string | null;
}

export interface WorkExecReviewPacket {
  workId: string;
  title: string;
  source: {
    type: string;
    label: string;
    artifact: string;
    url: string | null;
  };
  approvedGraphPath: string;
  materializationPath: string;
  tasks: WorkExecReviewTask[];
  messages: ReviewPacketMessage[];
}

export async function buildWorkSpecReviewPacket(paths: DevtaskPaths, item: WorkItem): Promise<WorkSpecReviewPacket> {
  const messages: ReviewPacketMessage[] = [];
  const planPath = workPlanPath(paths, item.id);
  const graphPath = workGraphPath(paths, item.id);
  const approvedGraphPath = workItemApprovedGraphPath(paths, item.id);
  const materializationPath = workItemMaterializationPath(paths, item.id);
  const planExists = fileHasContent(planPath);
  const graphExists = fs.existsSync(graphPath);
  const approvedGraphExists = fs.existsSync(approvedGraphPath);
  const materialization = readSafely(() => readWorkMaterialization(paths, item.id), messages, "Could not read materialization");
  const graph = readSafely(() => readWorkGraph(paths, item.id), messages, "Could not read work graph");
  const targets = new Set(listWorkspaceTargets(paths).map((target) => target.id));

  if (!planExists) {
    messages.push({ level: "blocker", message: `Missing work plan: ${planPath}` });
  }
  if (!graphExists) {
    messages.push({ level: "blocker", message: `Missing work graph: ${graphPath}` });
  }
  if (!approvedGraphExists) {
    messages.push({ level: "warning", message: "Work graph has not been approved/materialized yet." });
  }
  if (!materialization) {
    messages.push({ level: "warning", message: "Repo-local tasks have not been materialized yet." });
  }

  const materializedByGraphTask = new Map(materialization?.tasks.map((task) => [task.graphTaskId, task]) ?? []);
  const tasks = (graph?.tasks ?? []).map((task) => {
    const materialized = materializedByGraphTask.get(task.id);
    const repoPlanPath = materialized ? planMarkdownPath(pathsForRepo(materialized.repoPath), materialized.taskId) : null;
    const repoPlanExists = repoPlanPath ? fileHasContent(repoPlanPath) : false;
    if (!targets.has(task.target)) {
      messages.push({ level: "blocker", message: `Graph task ${task.id} references unknown target ${task.target}` });
    }
    if (materialization && !materialized) {
      messages.push({ level: "blocker", message: `Graph task ${task.id} is not materialized` });
    }
    if (materialized && !repoPlanExists) {
      messages.push({ level: "warning", message: `${task.target}/${materialized.taskId} is missing a repo plan` });
    }
    return {
      id: task.id,
      target: task.target,
      targetExists: targets.has(task.target),
      owns: task.owns,
      dependencies: task.dependencies.map((dependency) => `${dependency.type}:${dependency.task}`),
      materializedTaskId: materialized?.taskId ?? null,
      repoPlanPath,
      repoPlanExists
    };
  });

  return {
    workId: item.id,
    title: item.source.title,
    source: sourceSummary(item),
    planPath,
    planExists,
    graphPath,
    graphExists,
    approvedGraphPath,
    approvedGraphExists,
    materializationPath,
    materialized: materialization !== null,
    tasks,
    validation: graph?.validation ?? [],
    openQuestions: graph?.openQuestions ?? [],
    messages
  };
}

export async function buildWorkExecReviewPacket(paths: DevtaskPaths, item: WorkItem): Promise<WorkExecReviewPacket> {
  const messages: ReviewPacketMessage[] = [];
  const materialization = readSafely(() => readWorkMaterialization(paths, item.id), messages, "Could not read materialization");
  if (!materialization) {
    messages.push({ level: "blocker", message: `Work item ${item.id} has not been materialized.` });
    return {
      workId: item.id,
      title: item.source.title,
      source: sourceSummary(item),
      approvedGraphPath: workItemApprovedGraphPath(paths, item.id),
      materializationPath: workItemMaterializationPath(paths, item.id),
      tasks: [],
      messages
    };
  }

  const tasks: WorkExecReviewTask[] = [];
  for (const task of materialization.tasks) {
    const repoPaths = pathsForRepo(task.repoPath);
    const meta = getTask(repoPaths, task.taskId);
    const git = await inspectCommittedWork(meta.worktreePath);
    const stages = readStageLedger(repoPaths, task.taskId);
    const checkStatus = readLatestVerification(repoPaths, task.taskId)?.status ?? stages.stages.check?.status ?? "-";
    const agentReviewStatus = readLatestReviewAgent(repoPaths, task.taskId)?.status ?? stages.stages.review?.status ?? "-";
    const row: WorkExecReviewTask = {
      target: task.target,
      taskId: task.taskId,
      repoPath: task.repoPath,
      worktreePath: meta.worktreePath,
      branch: meta.branch,
      baseRef: git.baseRef,
      headSha: git.headSha,
      commitsAhead: git.commitsAhead,
      committedChangedFiles: git.committedChangedFiles,
      dirtyTrackedFiles: git.dirtyTrackedFiles,
      untrackedFiles: git.untrackedFiles,
      checkStatus,
      agentReviewStatus,
      taskStatus: meta.status,
      prUrl: meta.prUrl
    };
    addExecMessages(messages, row);
    tasks.push(row);
  }

  return {
    workId: item.id,
    title: item.source.title,
    source: sourceSummary(item),
    approvedGraphPath: materialization.approvedGraphPath,
    materializationPath: workItemMaterializationPath(paths, item.id),
    tasks,
    messages
  };
}

export function formatWorkSpecReviewPacket(packet: WorkSpecReviewPacket): string {
  return [
    `Review spec for ${packet.workId}`,
    "",
    `Source: ${packet.source.label}`,
    `Artifact: ${packet.source.artifact}`,
    ...(packet.source.url ? [`URL: ${packet.source.url}`] : []),
    "",
    "Artifacts:",
    `  Plan: ${formatExists(packet.planPath, packet.planExists)}`,
    `  Graph: ${formatExists(packet.graphPath, packet.graphExists)}`,
    `  Approved graph: ${formatExists(packet.approvedGraphPath, packet.approvedGraphExists)}`,
    `  Materialization: ${formatExists(packet.materializationPath, packet.materialized)}`,
    "",
    "Targets:",
    ...(packet.tasks.length
      ? packet.tasks.flatMap((task) => [
          `  ${task.target}/${task.id}`,
          `    target: ${task.targetExists ? "ok" : "missing"}`,
          `    owns: ${task.owns.length ? task.owns.join(", ") : "-"}`,
          `    dependencies: ${task.dependencies.length ? task.dependencies.join(", ") : "-"}`,
          `    repo plan: ${task.repoPlanPath ? formatExists(task.repoPlanPath, task.repoPlanExists) : "-"}`
        ])
      : ["  -"]),
    "",
    "Validation:",
    ...(packet.validation.length ? packet.validation.map((item) => `  ${item}`) : ["  -"]),
    "",
    "Open Questions:",
    ...(packet.openQuestions.length ? packet.openQuestions.map((item) => `  ${item}`) : ["  -"]),
    "",
    ...formatMessages(packet.messages),
    "",
    "Decision:",
    "  Is this spec clear and safe to approve for implementation?",
    "",
    `Next: devtask work approve-spec ${packet.workId}`
  ].join("\n");
}

export function formatWorkExecReviewPacket(packet: WorkExecReviewPacket): string {
  return [
    `Review execution for ${packet.workId}`,
    "",
    `Source: ${packet.source.label}`,
    `Artifact: ${packet.source.artifact}`,
    ...(packet.source.url ? [`URL: ${packet.source.url}`] : []),
    "",
    "Artifacts:",
    `  Approved graph: ${packet.approvedGraphPath}`,
    `  Materialization: ${packet.materializationPath}`,
    "",
    "Targets:",
    ...(packet.tasks.length
      ? packet.tasks.flatMap((task) => [
          `  ${task.target}/${task.taskId}`,
          `    branch: ${task.branch}`,
          `    base: ${task.baseRef ?? "-"}`,
          `    head: ${task.headSha ?? "-"}`,
          `    commits ahead: ${task.commitsAhead ?? "-"}`,
          `    committed files: ${task.committedChangedFiles.length ? task.committedChangedFiles.join(", ") : "-"}`,
          `    dirty tracked: ${task.dirtyTrackedFiles.length ? task.dirtyTrackedFiles.join(", ") : "-"}`,
          `    untracked: ${task.untrackedFiles.length ? task.untrackedFiles.join(", ") : "-"}`,
          `    checks: ${task.checkStatus}`,
          `    agent review: ${task.agentReviewStatus}`,
          `    task status: ${task.taskStatus}`,
          `    PR: ${task.prUrl ?? "-"}`
        ])
      : ["  -"]),
    "",
    ...formatMessages(packet.messages),
    "",
    "Decision:",
    "  Is this committed work safe to approve for publishing?",
    "",
    `Next: devtask work approve-exec ${packet.workId}`
  ].join("\n");
}

async function inspectCommittedWork(worktreePath: string): Promise<{
  baseRef: string | null;
  headSha: string | null;
  commitsAhead: number | null;
  committedChangedFiles: string[];
  dirtyTrackedFiles: string[];
  untrackedFiles: string[];
}> {
  const headSha = await optionalGit(worktreePath, ["rev-parse", "HEAD"]);
  const baseRef = await findBaseRef(worktreePath);
  const committedChangedFiles = baseRef
    ? (await optionalGit(worktreePath, ["diff", "--name-status", `${baseRef}...HEAD`]))?.split("\n").filter(Boolean) ?? []
    : [];
  const commitsAhead = baseRef
    ? Number.parseInt((await optionalGit(worktreePath, ["rev-list", "--count", `${baseRef}..HEAD`])) ?? "", 10)
    : null;
  const status = await optionalGit(worktreePath, ["status", "--porcelain"]);
  const dirtyTrackedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (const line of status?.split("\n").filter(Boolean) ?? []) {
    if (line.startsWith("?? ")) {
      untrackedFiles.push(line.slice(3));
    } else {
      dirtyTrackedFiles.push(line);
    }
  }
  return {
    baseRef,
    headSha,
    commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : null,
    committedChangedFiles,
    dirtyTrackedFiles,
    untrackedFiles
  };
}

async function findBaseRef(worktreePath: string): Promise<string | null> {
  const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    const result = await runCommand("git", ["rev-parse", "--verify", candidate], { cwd: worktreePath });
    if (result.exitCode === 0) {
      return candidate;
    }
  }
  return null;
}

async function optionalGit(worktreePath: string, args: string[]): Promise<string | null> {
  try {
    const result = await runCommandOrThrow("git", args, { cwd: worktreePath });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function addExecMessages(messages: ReviewPacketMessage[], task: WorkExecReviewTask): void {
  if (!task.baseRef) {
    messages.push({ level: "warning", message: `${task.target}/${task.taskId} has no detected base ref for committed diff review` });
  }
  if (task.commitsAhead === 0) {
    messages.push({ level: "warning", message: `${task.target}/${task.taskId} has no commits ahead of ${task.baseRef}` });
  }
  if (task.dirtyTrackedFiles.length > 0) {
    messages.push({ level: "blocker", message: `${task.target}/${task.taskId} has dirty tracked files` });
  }
  if (task.untrackedFiles.length > 0) {
    messages.push({ level: "warning", message: `${task.target}/${task.taskId} has untracked files not included in commits` });
  }
  if (task.checkStatus !== "passed") {
    messages.push({ level: "blocker", message: `${task.target}/${task.taskId} checks are ${task.checkStatus}` });
  }
  if (task.agentReviewStatus !== "passed") {
    messages.push({ level: "blocker", message: `${task.target}/${task.taskId} agent review is ${task.agentReviewStatus}` });
  }
}

function sourceSummary(item: WorkItem): WorkSpecReviewPacket["source"] {
  return {
    type: item.source.type,
    label: "key" in item.source ? `${item.source.key} - ${item.source.title}` : `${item.id} - ${item.source.title}`,
    artifact: item.source.artifact,
    url: "url" in item.source ? item.source.url : null
  };
}

function pathsForRepo(repoPath: string): DevtaskPaths {
  return {
    root: repoPath,
    baseDir: path.join(repoPath, ".devtask"),
    configPath: path.join(repoPath, ".devtask", "config.json"),
    tasksDir: path.join(repoPath, ".devtask", "tasks"),
    worktreesDir: path.join(repoPath, ".devtask", "worktrees"),
    workDir: path.join(repoPath, ".devtask", "work")
  };
}

function fileHasContent(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").trim().length > 0;
}

function readSafely<T>(read: () => T, messages: ReviewPacketMessage[], prefix: string): T | null {
  try {
    return read();
  } catch (error) {
    messages.push({ level: "blocker", message: `${prefix}: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
}

function formatExists(filePath: string, exists: boolean): string {
  return `${filePath} (${exists ? "ok" : "missing"})`;
}

function formatMessages(messages: ReviewPacketMessage[]): string[] {
  if (messages.length === 0) {
    return ["Warnings/Blockers:", "  -"];
  }
  return [
    "Warnings/Blockers:",
    ...messages.map((message) => `  ${message.level.toUpperCase()} ${message.message}`)
  ];
}
