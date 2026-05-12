import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkerExecutablePath } from "../src/cli/support.js";

describe("worker executable path", () => {
  it("resolves the worker next to the active CLI entrypoint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-worker-path-"));
    const cliPath = path.join(dir, "devtask.js");
    const workerPath = path.join(dir, "devtask-worker.js");
    fs.writeFileSync(cliPath, "");
    fs.writeFileSync(workerPath, "");

    expect(resolveWorkerExecutablePath(cliPath)).toBe(workerPath);
  });
});
