import { describe, expect, it, vi } from "vitest";
import { printTable } from "../src/cli/common.js";

describe("cli common", () => {
  it("prints rows with missing trailing cells without crashing", () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      lines.push(String(value ?? ""));
    });

    expect(() => {
      printTable(["A", "B", "C"], [["x", "y"]]);
    }).not.toThrow();

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("x");
    expect(lines[1]).toContain("y");
    log.mockRestore();
  });
});
