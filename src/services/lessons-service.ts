import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import {
  workItemLessonProposalsPath,
  lessonProposalsArchivePath
} from "../infra/paths.js";
import type { MemoryPhase } from "../improvement-memory.js";

export type LessonProposalStatus = "pending" | "approved" | "rejected";

export interface LessonProposal {
  id: string;
  workId: string;
  repoId: string;
  assertionId: string;
  phase: MemoryPhase;
  lesson: string;
  trigger: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
  proposedAt: string;
  status: LessonProposalStatus;
  rejectionReason?: string;
  approvedAt?: string;
  rejectedAt?: string;
}

export function listPendingProposals(paths: DevtaskPaths, workId: string): LessonProposal[] {
  return readProposals(paths, workId).filter((p) => p.status === "pending");
}

export function listAllProposals(paths: DevtaskPaths, workId: string): LessonProposal[] {
  return readProposals(paths, workId);
}

export function approveProposal(paths: DevtaskPaths, workId: string, proposalId: string): void {
  const proposalsPath = workItemLessonProposalsPath(paths, workId);
  const proposals = readProposals(paths, workId);
  const idx = proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error(`Proposal "${proposalId}" not found in work item ${workId}`);
  }
  const proposal = proposals[idx];
  if (proposal.status !== "pending") {
    throw new Error(`Proposal "${proposalId}" is already ${proposal.status}`);
  }

  const approved: LessonProposal = { ...proposal, status: "approved", approvedAt: new Date().toISOString() };

  promoteToImprovementMemory(paths, approved);

  archiveProposal(paths, approved);

  proposals[idx] = approved;
  writeProposals(proposalsPath, proposals);
}

export function rejectProposal(paths: DevtaskPaths, workId: string, proposalId: string, reason: string): void {
  const proposalsPath = workItemLessonProposalsPath(paths, workId);
  const proposals = readProposals(paths, workId);
  const idx = proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error(`Proposal "${proposalId}" not found in work item ${workId}`);
  }
  const proposal = proposals[idx];
  if (proposal.status !== "pending") {
    throw new Error(`Proposal "${proposalId}" is already ${proposal.status}`);
  }

  const rejected: LessonProposal = {
    ...proposal,
    status: "rejected",
    rejectionReason: reason,
    rejectedAt: new Date().toISOString()
  };

  archiveProposal(paths, rejected);

  proposals[idx] = rejected;
  writeProposals(proposalsPath, proposals);
}

function promoteToImprovementMemory(paths: DevtaskPaths, proposal: LessonProposal): void {
  const improvementFile = path.join(paths.sharedDir, "improvement", `${proposal.phase}.md`);
  fs.mkdirSync(path.dirname(improvementFile), { recursive: true });

  const entry = [
    `\n## Lesson (from ${proposal.workId}/${proposal.repoId} — ${proposal.assertionId})`,
    ``,
    proposal.lesson,
    ``,
    `_Confidence: ${proposal.confidence} · Approved: ${proposal.approvedAt ?? "unknown"}_`
  ].join("\n");

  fs.appendFileSync(improvementFile, `${entry}\n`);
}

function archiveProposal(paths: DevtaskPaths, proposal: LessonProposal): void {
  const archivePath = lessonProposalsArchivePath(paths);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.appendFileSync(archivePath, `${JSON.stringify(proposal)}\n`);
}

function readProposals(paths: DevtaskPaths, workId: string): LessonProposal[] {
  const proposalsPath = workItemLessonProposalsPath(paths, workId);
  if (!fs.existsSync(proposalsPath)) return [];
  const lines = fs.readFileSync(proposalsPath, "utf8").split("\n").filter((l) => l.trim());
  const proposals: LessonProposal[] = [];
  for (const line of lines) {
    try {
      proposals.push(JSON.parse(line) as LessonProposal);
    } catch {
      // skip malformed lines
    }
  }
  return proposals;
}

function writeProposals(proposalsPath: string, proposals: LessonProposal[]): void {
  fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
  const content = proposals.map((p) => JSON.stringify(p)).join("\n");
  fs.writeFileSync(proposalsPath, content ? `${content}\n` : "");
}
