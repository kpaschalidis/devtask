import { readRunningPhaseRun, resolveSessionRef, updateRunningPhaseRun, writePhaseRunRecord, type SessionPhase, type SessionRun } from "../infra/session-run.js";
import type { DevtaskPaths } from "../infra/paths.js";
import { phaseRunDir } from "../infra/paths.js";
import { killTmuxSession, tmuxSessionExists } from "../adapters/agent-kernel/tmux-control.js";
import { DevtaskError } from "../infra/errors.js";
import { launchPhaseFresh } from "../roles/runner.js";
import { orchestratorPhase } from "../roles/orchestrator.js";
import { reviewPhase } from "../roles/validator.js";
import { executePhase, sendRawExecuteFeedback } from "../roles/execute.js";
import type { RoleConfig } from "../roles/types.js";
import { getLatestWorkPhaseRun } from "./session-run-service.js";
import { readWorkGraph, readWorkMaterialization, type WorkMaterialization } from "./work-materialization-service.js";
import { getWorkItem, updateWorkItemStatus, type WorkItemStatus } from "../storage/work-store.js";
import { updateRecentWork } from "../storage/global-index.js";

export interface PhaseLaunchResult {
  phase: string;
  workId: string;
  repoId: string | null;
  taskId: string | null;
  status: "started" | "running";
  tmuxSession: string;
  promptPath: string;
  outputPath: string;
}

type InteractivePhase = "orchestrate" | "review";

const PHASE_CONFIGS: Record<InteractivePhase, RoleConfig> = {
  orchestrate: orchestratorPhase,
  review: reviewPhase,
};

export function attachWorkPhase(paths: DevtaskPaths, phase: "orchestrate", workId: string): Promise<void>;
export function attachWorkPhase(paths: DevtaskPaths, phase: "review" | "execute", workId: string, repoId: string): Promise<void>;
export async function attachWorkPhase(
  paths: DevtaskPaths,
  phase: "orchestrate" | "review" | "execute",
  workId: string,
  repoId?: string,
): Promise<void> {
  const scopeRepoId = repoId ?? null;
  switch (phase) {
    case "orchestrate": return orchestratorPhase.attach(paths, workId, null);
    case "review": return reviewPhase.attach(paths, workId, scopeRepoId);
    case "execute": return executePhase.attach(paths, workId, scopeRepoId);
  }
}

export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "orchestrate",
  workId: string,
  message: string,
): Promise<PhaseLaunchResult>;
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "review",
  workId: string,
  repoId: string,
  message: string,
): Promise<PhaseLaunchResult>;
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "execute",
  workId: string,
  repoId: string,
  message: string,
): { confirmed: boolean; output: string };
export function sendWorkPhaseFeedback(
  paths: DevtaskPaths,
  phase: "orchestrate" | "review" | "execute",
  workId: string,
  repoOrMessage: string,
  maybeMessage?: string,
): Promise<PhaseLaunchResult> | { confirmed: boolean; output: string } {
  const repoId = maybeMessage === undefined ? null : repoOrMessage;
  const message = maybeMessage === undefined ? repoOrMessage : maybeMessage;
  if (phase === "execute") {
    return sendRawExecuteFeedback(paths, workId, repoId!, message);
  }
  switch (phase) {
    case "orchestrate": return orchestratorPhase.sendFeedback(paths, workId, null, message);
    case "review": return reviewPhase.sendFeedback(paths, workId, repoId, message);
  }
}

export async function startOrchestrateWork(
  paths: DevtaskPaths,
  workId: string,
  opts?: { acceptRecommended?: boolean },
): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(orchestratorPhase, paths, workId, "orchestrate", null, opts);
}

export async function startReviewWork(paths: DevtaskPaths, workId: string): Promise<PhaseLaunchResult[]> {
  const materialization = requireMaterialization(paths, workId);
  const launches: PhaseLaunchResult[] = [];
  for (const task of materialization.tasks) {
    launches.push(await startReviewScope(paths, workId, task.repoId));
  }
  return launches;
}

export async function startReviewScope(paths: DevtaskPaths, workId: string, repoId: string): Promise<PhaseLaunchResult> {
  return launchPhaseFresh(reviewPhase, paths, workId, "review", repoId);
}

export async function runValidateWorker(paths: DevtaskPaths, workId: string, featureId: string): Promise<void> {
  const graph = readWorkGraph(paths, workId);
  const feature = graph.features.find((entry) => entry.id === featureId);
  if (!feature) {
    throw new DevtaskError(`No feature "${featureId}" found in graph for work item ${workId}`);
  }
  if (!feature.validationRequired) {
    return;
  }
  const featureTasks = graph.tasks.filter((entry) => feature.taskIds.includes(entry.id));
  if (featureTasks.length === 0) {
    throw new DevtaskError(`Feature "${featureId}" has no tasks in graph for work item ${workId}`);
  }
  const repoIds = [...new Set(featureTasks.map((entry) => entry.repoId))];
  for (const repoId of repoIds) {
    await startReviewScope(paths, workId, repoId);
  }
}

export async function runManagedPhaseHookFinalizer(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  runId: string,
  repoId: string | null,
): Promise<void> {
  const current = readRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId));
  if (!current || current.runId !== runId || current.status !== "running") {
    return;
  }
  const { status } = await finalizeInteractivePhase(paths, phase, workId, repoId, current);
  if (status !== "failed" && current.tmuxSession && tmuxSessionExists(current.tmuxSession)) {
    killTmuxSession(current.tmuxSession);
  }
}

async function finalizeInteractivePhase(
  paths: DevtaskPaths,
  phase: InteractivePhase,
  workId: string,
  repoId: string | null,
  sessionRecord: SessionRun,
): Promise<{ status: string }> {
  const cfg = PHASE_CONFIGS[phase];
  const finishedAt = new Date().toISOString();
  const { status, artifacts } = await cfg.finalize(paths, workId, repoId, sessionRecord);
  const normalizedSession = normalizeSessionRecord(sessionRecord);
  const itemStatus = phaseWorkItemStatus(phase, status);
  if (itemStatus !== null) {
    updateWorkItemStatus(paths, workId, itemStatus);
    await updateRecentWork(paths, getWorkItem(paths, workId));
  }
  writePhaseRunRecord(phaseRunDir(paths, workId, phase, repoId), {
    schemaVersion: 1,
    phase,
    runId: sessionRecord.runId,
    workId,
    repoId: repoId ?? null,
    taskId: sessionRecord.taskId,
    status,
    promptPath: sessionRecord.promptPath,
    outputPath: sessionRecord.outputPath,
    startedAt: sessionRecord.startedAt,
    finishedAt,
    artifacts,
    session: normalizedSession.session,
    kernelSession: normalizedSession.kernelSession,
    exitCode: status === "failed" ? null : 0,
  });
  updateRunningPhaseRun(phaseRunDir(paths, workId, phase, repoId), {
    status: status === "blocked" ? "blocked" : status === "failed" ? "failed" : "completed",
    updatedAt: finishedAt,
    promptPath: sessionRecord.promptPath,
    outputPath: sessionRecord.outputPath,
    artifacts,
    taskId: sessionRecord.taskId,
    runId: sessionRecord.runId,
    session: normalizedSession.session,
    kernelSession: normalizedSession.kernelSession,
  });
  return { status };
}

function normalizeSessionRecord(sessionRecord: SessionRun): Pick<SessionRun, "session" | "kernelSession"> {
  const kernelSession = sessionRecord.kernelSession ?? synthesizeKernelSession(sessionRecord);
  return {
    session: kernelSession
      ? resolveSessionRef({ tmuxSession: sessionRecord.tmuxSession, kernelSession })
      : sessionRecord.session,
    kernelSession,
  };
}

function synthesizeKernelSession(sessionRecord: SessionRun): SessionRun["kernelSession"] {
  const resume = sessionRecord.session.resumeContext;
  const threadId = resume.providerSessionId ?? resume.conversationId ?? resume.resumeTarget ?? null;
  const transportId = sessionRecord.tmuxSession ?? sessionRecord.session.transportId ?? null;
  if (!threadId && !transportId && !resume.storageRoot && !resume.transcriptPath) {
    return null;
  }
  return {
    runtimeSessionId: transportId ?? "unknown",
    runtimeName: "tmux",
    threadId,
    data: {
      sessionName: transportId,
      threadId,
      codexHome: resume.storageRoot ?? null,
      transcriptPath: resume.transcriptPath ?? null,
      agentName: sessionRecord.session.provider,
    },
  };
}

function phaseWorkItemStatus(phase: InteractivePhase, status: string): WorkItemStatus | null {
  switch (phase) {
    case "orchestrate": return status === "planned" ? "planned" : "failed";
    case "review": return null;
  }
}

function requireMaterialization(paths: DevtaskPaths, workId: string): WorkMaterialization {
  const materialization = readWorkMaterialization(paths, workId);
  if (!materialization) {
    throw new DevtaskError(`Work item ${workId} has not been materialized`);
  }
  return materialization;
}
