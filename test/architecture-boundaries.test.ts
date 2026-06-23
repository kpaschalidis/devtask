import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../src");
const ADAPTER_DIR = path.join(SRC_ROOT, "adapters", "agent-kernel");
const KERNEL_DIR = path.join(SRC_ROOT, "kernel");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("architecture boundaries", () => {
  it("no src file outside adapters/agent-kernel imports from src/kernel directly", () => {
    const violations: string[] = [];
    const allSrcFiles = collectTsFiles(SRC_ROOT);
    const outsideAdapter = allSrcFiles.filter((f) => !f.startsWith(ADAPTER_DIR + path.sep));

    for (const file of outsideAdapter) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim().startsWith("import") && !line.trim().startsWith("export")) continue;
        const match = line.match(/from\s+["']([^"']+)["']/);
        if (!match) continue;
        const specifier = match[1];
        if (specifier.includes("/kernel/") || specifier.endsWith("/kernel")) {
          violations.push(`${path.relative(SRC_ROOT, file)}: ${line.trim()}`);
        }
      }
    }

    expect(violations, `Direct kernel imports found outside adapters/agent-kernel:\n${violations.join("\n")}`).toHaveLength(0);
  });

  it("no src file outside adapters/agent-kernel imports @devtask/agent-kernel", () => {
    const violations: string[] = [];
    const allSrcFiles = collectTsFiles(SRC_ROOT);
    const outsideAdapter = allSrcFiles.filter((f) => !f.startsWith(ADAPTER_DIR + path.sep));

    for (const file of outsideAdapter) {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("@devtask/agent-kernel")) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }

    expect(violations, `@devtask/agent-kernel imports found outside adapters/agent-kernel:\n${violations.join("\n")}`).toHaveLength(0);
  });

  it("kernel package contains no devtask application imports", () => {
    const violations: string[] = [];
    const kernelFiles = collectTsFiles(KERNEL_DIR);

    for (const file of kernelFiles) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim().startsWith("import") && !line.trim().startsWith("export")) continue;
        const match = line.match(/from\s+["']([^"']+)["']/);
        if (!match) continue;
        const specifier = match[1];
        if (specifier === "devtask" || specifier.startsWith("devtask/")) {
          violations.push(`${path.relative(KERNEL_DIR, file)}: ${line.trim()}`);
        }
      }
    }

    expect(violations, `Devtask imports found in kernel:\n${violations.join("\n")}`).toHaveLength(0);
  });
});
