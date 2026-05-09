import { afterEach, describe, expect, it, vi } from "vitest";
import { DevtaskError } from "../src/errors.js";
import { runCommandOrThrow } from "../src/process-runner.js";
import { checkProviderCi, parseRemoteUrl } from "../src/scm.js";
import { makeTempRepo } from "./helpers.js";

const originalBitbucketEmail = process.env.BITBUCKET_EMAIL;
const originalBitbucketToken = process.env.BITBUCKET_API_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBitbucketEmail === undefined) {
    delete process.env.BITBUCKET_EMAIL;
  } else {
    process.env.BITBUCKET_EMAIL = originalBitbucketEmail;
  }
  if (originalBitbucketToken === undefined) {
    delete process.env.BITBUCKET_API_TOKEN;
  } else {
    process.env.BITBUCKET_API_TOKEN = originalBitbucketToken;
  }
});

describe("scm", () => {
  it("detects GitHub remotes", () => {
    expect(parseRemoteUrl("git@github.com:acme/web.git")).toMatchObject({
      provider: "github",
      owner: "acme",
      repo: "web"
    });
    expect(parseRemoteUrl("https://github.com/acme/api.git")).toMatchObject({
      provider: "github",
      owner: "acme",
      repo: "api"
    });
  });

  it("detects Bitbucket remotes", () => {
    expect(parseRemoteUrl("git@bitbucket.org:studio/backend.git")).toMatchObject({
      provider: "bitbucket",
      owner: "studio",
      repo: "backend"
    });
    expect(parseRemoteUrl("https://bitbucket.org/studio/cid-cms.git")).toMatchObject({
      provider: "bitbucket",
      owner: "studio",
      repo: "cid-cms"
    });
  });

  it("detects GitLab remotes", () => {
    expect(parseRemoteUrl("git@gitlab.com:acme/platform.git")).toMatchObject({
      provider: "gitlab",
      owner: "acme",
      repo: "platform"
    });
  });

  it("rejects unsupported remote hosts", () => {
    expect(() => parseRemoteUrl("git@example.com:acme/web.git")).toThrow(DevtaskError);
  });

  it("checks Bitbucket Pipelines for the task branch", async () => {
    const repo = await makeTempRepo({ withCommit: true });
    await runCommandOrThrow("git", ["remote", "add", "origin", "https://bitbucket.org/studio/backend.git"], {
      cwd: repo
    });
    process.env.BITBUCKET_EMAIL = "devtask@example.local";
    process.env.BITBUCKET_API_TOKEN = "token";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          values: [
            {
              build_number: 12,
              target: { ref_name: "task/other" },
              state: { name: "COMPLETED", result: { name: "FAILED" } }
            },
            {
              build_number: 13,
              target: { ref_name: "task/cps-549" },
              state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
              links: {
                html: {
                  href: "https://bitbucket.org/studio/backend/pipelines/results/13"
                }
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkProviderCi(
      repo,
      "https://bitbucket.org/studio/backend/pull-requests/1",
      "task/cps-549"
    );

    expect(result).toEqual({
      provider: "bitbucket",
      status: "passed",
      detail: "pipeline 13: state=completed, result=successful",
      url: "https://bitbucket.org/studio/backend/pipelines/results/13"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining("/repositories/studio/backend/pipelines")
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json"
        })
      })
    );
  });
});
