import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/services/workspace-service.js";

describe("workspace init", () => {
  it("creates .agents/skills/ directory during createWorkspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-workspace-skills-"));

    createWorkspace(root, { id: "ws-test", name: "Test Workspace", register: false });

    expect(fs.existsSync(path.join(root, ".agents", "skills"))).toBe(true);
    expect(fs.statSync(path.join(root, ".agents", "skills")).isDirectory()).toBe(true);
  });
});
