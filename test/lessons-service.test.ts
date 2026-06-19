import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listPendingProposals,
  listAllProposals,
  approveProposal,
  rejectProposal
} from "../src/services/lessons-service.js";
import {
  workItemLessonProposalsPath,
  lessonProposalsArchivePath
} from "../src/infra/paths.js";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-lessons-"));
  const paths = resolveWorkspacePathsForInit(workspace);
  initializeWorkspace(paths);
  return paths;
}

function writeProposal(paths: ReturnType<typeof resolveWorkspacePathsForInit>, proposal: object): void {
  const filePath = workItemLessonProposalsPath(paths, "work-1");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(proposal)}\n`);
}

const baseProposal = {
  id: "work-1-backend-VAL-001",
  workId: "work-1",
  repoId: "backend",
  assertionId: "VAL-001",
  phase: "planning" as const,
  lesson: "Define error states for every user-facing operation.",
  trigger: "VAL-001 failed because no error state was specified.",
  confidence: "high" as const,
  evidence: "/results/review.json#VAL-001",
  proposedAt: "2025-01-01T00:00:00.000Z",
  status: "pending" as const
};

describe("lessons service", () => {
  it("returns empty list when no proposals file exists", () => {
    const paths = makeWorkspace();
    expect(listPendingProposals(paths, "work-1")).toEqual([]);
  });

  it("lists pending proposals", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);
    const pending = listPendingProposals(paths, "work-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(baseProposal.id);
    expect(pending[0].status).toBe("pending");
  });

  it("approve promotes lesson to shared improvement memory", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    approveProposal(paths, "work-1", baseProposal.id);

    const improvementFile = path.join(paths.sharedDir, "improvement", "planning.md");
    expect(fs.existsSync(improvementFile)).toBe(true);
    const content = fs.readFileSync(improvementFile, "utf8");
    expect(content).toContain(baseProposal.lesson);
    expect(content).toContain(baseProposal.workId);
    expect(content).toContain(baseProposal.assertionId);
  });

  it("approve updates status to approved in proposals file", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    approveProposal(paths, "work-1", baseProposal.id);

    const all = listAllProposals(paths, "work-1");
    expect(all[0].status).toBe("approved");
    expect(all[0].approvedAt).toBeDefined();
  });

  it("approve writes to archive", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    approveProposal(paths, "work-1", baseProposal.id);

    const archivePath = lessonProposalsArchivePath(paths);
    expect(fs.existsSync(archivePath)).toBe(true);
    const lines = fs.readFileSync(archivePath, "utf8").trim().split("\n");
    const archived = JSON.parse(lines[0]) as { id: string; status: string };
    expect(archived.id).toBe(baseProposal.id);
    expect(archived.status).toBe("approved");
  });

  it("approve does not appear in pending list afterwards", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    approveProposal(paths, "work-1", baseProposal.id);

    expect(listPendingProposals(paths, "work-1")).toHaveLength(0);
  });

  it("reject updates status with reason", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    rejectProposal(paths, "work-1", baseProposal.id, "Not actionable for this codebase.");

    const all = listAllProposals(paths, "work-1");
    expect(all[0].status).toBe("rejected");
    expect(all[0].rejectionReason).toBe("Not actionable for this codebase.");
    expect(all[0].rejectedAt).toBeDefined();
  });

  it("reject writes to archive", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    rejectProposal(paths, "work-1", baseProposal.id, "irrelevant");

    const archivePath = lessonProposalsArchivePath(paths);
    const lines = fs.readFileSync(archivePath, "utf8").trim().split("\n");
    const archived = JSON.parse(lines[0]) as { status: string };
    expect(archived.status).toBe("rejected");
  });

  it("reject does not write to improvement memory", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);

    rejectProposal(paths, "work-1", baseProposal.id, "no reason");

    const improvementFile = path.join(paths.sharedDir, "improvement", "planning.md");
    expect(fs.existsSync(improvementFile)).toBe(false);
  });

  it("throws when approving a non-existent proposal", () => {
    const paths = makeWorkspace();
    expect(() => approveProposal(paths, "work-1", "nonexistent-id")).toThrow(/not found/);
  });

  it("throws when approving an already approved proposal", () => {
    const paths = makeWorkspace();
    writeProposal(paths, baseProposal);
    approveProposal(paths, "work-1", baseProposal.id);
    expect(() => approveProposal(paths, "work-1", baseProposal.id)).toThrow(/already approved/);
  });

  it("multiple proposals coexist; each can be acted on independently", () => {
    const paths = makeWorkspace();
    const proposal2 = {
      ...baseProposal,
      id: "work-1-backend-VAL-002",
      assertionId: "VAL-002",
      phase: "implementation" as const
    };
    writeProposal(paths, baseProposal);
    writeProposal(paths, proposal2);

    approveProposal(paths, "work-1", baseProposal.id);
    rejectProposal(paths, "work-1", proposal2.id, "not relevant");

    expect(listPendingProposals(paths, "work-1")).toHaveLength(0);
    const all = listAllProposals(paths, "work-1");
    expect(all.find((p) => p.id === baseProposal.id)?.status).toBe("approved");
    expect(all.find((p) => p.id === proposal2.id)?.status).toBe("rejected");
  });
});
