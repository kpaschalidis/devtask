import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePathsForInit } from "../src/infra/paths.js";
import { initializeWorkspace } from "../src/storage/task-store.js";
import { readGateState, writeGateState } from "../src/mission/gates.js";
import { approveWorkGate } from "../src/mission/approve.js";

describe("gates", () => {
  it("writeGateState / readGateState roundtrip gate-1 as approved", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-gates-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    expect(readGateState(paths, "WORK-1", "gate-1")).toBeNull();

    writeGateState(paths, "WORK-1", "gate-1", {
      status: "approved",
      message: "Looks good"
    });

    const state = readGateState(paths, "WORK-1", "gate-1");
    expect(state).not.toBeNull();
    expect(state?.gate).toBe("gate-1");
    expect(state?.workId).toBe("WORK-1");
    expect(state?.status).toBe("approved");
    expect(state?.message).toBe("Looks good");
    expect(state?.updatedAt).toBeTruthy();
  });

  it("writeGateState merges with existing state on second write", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-gates-merge-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    writeGateState(paths, "WORK-1", "gate-2", { status: "pending" });
    writeGateState(paths, "WORK-1", "gate-2", { status: "approved", message: "Ship it" });

    const state = readGateState(paths, "WORK-1", "gate-2");
    expect(state?.status).toBe("approved");
    expect(state?.message).toBe("Ship it");
  });

  it("gate-1 and gate-2 are stored independently", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-gates-indep-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    writeGateState(paths, "WORK-1", "gate-1", { status: "approved" });
    writeGateState(paths, "WORK-1", "gate-2", { status: "rejected" });

    expect(readGateState(paths, "WORK-1", "gate-1")?.status).toBe("approved");
    expect(readGateState(paths, "WORK-1", "gate-2")?.status).toBe("rejected");
  });
});

describe("approveWorkGate", () => {
  it("throws DevtaskError with guidance when no running orchestrator session exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-approve-"));
    const paths = resolveWorkspacePathsForInit(workspace);
    initializeWorkspace(paths);

    await expect(approveWorkGate(paths, "WORK-999", "gate-1")).rejects.toThrow(
      'No orchestrator session found for work item "WORK-999"'
    );
  });
});
