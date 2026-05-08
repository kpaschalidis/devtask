import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { hasRuntimeConfig, readConfig, writeConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { makeTempRepo } from "./helpers.js";

describe("config", () => {
  it("defaults missing runtime config to plain while reporting it as unconfigured", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          codex: {
            model: null,
            fullAuto: true
          },
          verify: []
        },
        null,
        2
      )
    );

    expect(hasRuntimeConfig(paths)).toBe(false);
    expect(readConfig(paths).runtime).toEqual({
      mode: "plain",
      backend: null
    });
  });

  it("detects explicit runtime config", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);
    writeConfig(paths, {
      schemaVersion: 1,
      codex: {
        model: null,
        fullAuto: true
      },
      runtime: {
        mode: "attachable",
        backend: "tmux"
      },
      verify: []
    });

    expect(hasRuntimeConfig(paths)).toBe(true);
  });
});
