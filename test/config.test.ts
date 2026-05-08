import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCodexCommand, hasRuntimeConfig, readConfig, writeConfig } from "../src/config.js";
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
      runtimeConfigured: true,
      jira: {
        baseUrl: null,
        email: null,
        cloudId: null
      },
      verify: []
    });

    expect(hasRuntimeConfig(paths)).toBe(true);
  });

  it("does not treat generated plain runtime config as explicit", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);
    writeConfig(paths, {
      schemaVersion: 1,
      codex: {
        model: null,
        fullAuto: true
      },
      runtime: {
        mode: "plain",
        backend: null
      },
      runtimeConfigured: false,
      jira: {
        baseUrl: null,
        email: null,
        cloudId: null
      },
      verify: []
    });

    expect(hasRuntimeConfig(paths)).toBe(false);
  });

  it("reads Jira config when present", async () => {
    const repo = await makeTempRepo();
    const paths = resolvePaths(repo);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify({
        schemaVersion: 1,
        jira: {
          baseUrl: "https://example.atlassian.net/",
          email: "dev@example.com",
          cloudId: "cloud-123"
        }
      })
    );

    expect(readConfig(paths).jira).toEqual({
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      cloudId: "cloud-123"
    });
  });

  it("can build Codex commands for non-git workspace execution", () => {
    expect(buildCodexCommand({ skipGitRepoCheck: true })).toContain("--skip-git-repo-check");
  });
});
