import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globalDevtaskDir } from "../src/infra/paths.js";

describe("test setup isolation", () => {
  it("runs the suite with a disposable devtask home", () => {
    const home = globalDevtaskDir();

    expect(home.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(home)).toMatch(/^devtask-home-/);
  });
});
