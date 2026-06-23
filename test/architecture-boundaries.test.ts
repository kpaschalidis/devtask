import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../src");
const ADAPTER_DIR = path.join(SRC_ROOT, "adapters", "agent-kernel");
const KERNEL_PKG = "@devtask/agent-kernel";

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

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const source = ts.createSourceFile("source.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

describe("architecture boundaries", () => {
  it("no src file outside adapters/agent-kernel imports @devtask/agent-kernel", () => {
    const violations: string[] = [];
    const outside = collectTsFiles(SRC_ROOT).filter((f) => !f.startsWith(ADAPTER_DIR + path.sep));
    for (const file of outside) {
      const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));
      if (specifiers.some((s) => s === KERNEL_PKG || s.startsWith(KERNEL_PKG + "/"))) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violations, `@devtask/agent-kernel imports outside adapters/agent-kernel:\n${violations.join("\n")}`).toHaveLength(0);
  });

  it("packages/agent-kernel contains no devtask application imports", () => {
    const pkgSrc = path.resolve(__dirname, "../packages/agent-kernel/src");
    const violations: string[] = [];
    for (const file of collectTsFiles(pkgSrc)) {
      const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));
      if (specifiers.some((s) => s === "devtask" || s.startsWith("devtask/") || relativeImportEscapesPackage(file, s, pkgSrc))) {
        violations.push(path.relative(pkgSrc, file));
      }
    }
    expect(violations, `Devtask imports found in agent-kernel package:\n${violations.join("\n")}`).toHaveLength(0);
  });

  it("devtask source does not bypass the package API with package-relative imports", () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));
      if (specifiers.some((specifier) => specifier.includes("packages/agent-kernel"))) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violations, `Direct agent-kernel source imports found:\n${violations.join("\n")}`).toHaveLength(0);
  });
});

function relativeImportEscapesPackage(file: string, specifier: string, packageRoot: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved !== packageRoot && !resolved.startsWith(packageRoot + path.sep);
}
