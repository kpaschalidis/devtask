import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readReviewResultFromPath } from "../src/roles/validator.js";

describe("validator assertion parser", () => {
  function writeTempResult(content: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-validator-"));
    const filePath = path.join(dir, "result.json");
    fs.writeFileSync(filePath, JSON.stringify(content));
    return filePath;
  }

  it("returns null for a missing file", () => {
    expect(readReviewResultFromPath("/nonexistent/path/result.json")).toBeNull();
  });

  it("parses a passed result with attributed assertions", () => {
    const filePath = writeTempResult({
      schemaVersion: 1,
      status: "passed",
      assertions: [
        { id: "VAL-001", status: "passed", evidence: "src/api.ts:42", attribution: null, attributionReason: null }
      ],
      commands: []
    });

    const result = readReviewResultFromPath(filePath);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("passed");
    expect(result!.assertions).toHaveLength(1);
    expect(result!.assertions[0]).toMatchObject({
      id: "VAL-001",
      status: "passed",
      attribution: null,
      attributionReason: null
    });
  });

  it("parses failed assertions with attribution", () => {
    const filePath = writeTempResult({
      schemaVersion: 1,
      status: "failed",
      assertions: [
        {
          id: "VAL-001",
          status: "failed",
          evidence: "missing handler",
          attribution: "implementation-gap",
          attributionReason: "The spec required error handling but the function has no try/catch."
        },
        {
          id: "VAL-002",
          status: "failed",
          evidence: "spec does not mention this case",
          attribution: "spec-gap",
          attributionReason: "No error state was defined in the spec."
        }
      ],
      commands: []
    });

    const result = readReviewResultFromPath(filePath);
    expect(result!.status).toBe("failed");
    expect(result!.assertions[0].attribution).toBe("implementation-gap");
    expect(result!.assertions[1].attribution).toBe("spec-gap");
  });

  it("parses blocked status", () => {
    const filePath = writeTempResult({
      schemaVersion: 1,
      status: "blocked",
      assertions: [
        { id: "VAL-001", status: "skipped", evidence: "environment-blocked: tsc not found", attribution: "environment", attributionReason: "tsc missing" }
      ],
      commands: [{ command: "npx tsc", exitCode: 127, output: "tsc: command not found" }]
    });

    const result = readReviewResultFromPath(filePath);
    expect(result!.status).toBe("blocked");
    expect(result!.assertions[0].attribution).toBe("environment");
  });

  it("returns empty assertions array for old-format results without assertions field", () => {
    const filePath = writeTempResult({ status: "passed" });
    const result = readReviewResultFromPath(filePath);
    expect(result!.assertions).toEqual([]);
  });

  it("skips malformed assertion entries without throwing", () => {
    const filePath = writeTempResult({
      status: "failed",
      assertions: [
        null,
        { id: "VAL-001", status: "passed", evidence: "ok", attribution: null, attributionReason: null },
        { status: "failed" },
        "not-an-object"
      ]
    });

    const result = readReviewResultFromPath(filePath);
    expect(result!.assertions).toHaveLength(1);
    expect(result!.assertions[0].id).toBe("VAL-001");
  });

  it("normalises unknown attribution values to null", () => {
    const filePath = writeTempResult({
      status: "failed",
      assertions: [
        { id: "VAL-001", status: "failed", evidence: "x", attribution: "unknown-value", attributionReason: null }
      ]
    });

    const result = readReviewResultFromPath(filePath);
    expect(result!.assertions[0].attribution).toBeNull();
  });
});
