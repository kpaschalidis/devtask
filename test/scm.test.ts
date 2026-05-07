import { describe, expect, it } from "vitest";
import { DevtaskError } from "../src/errors.js";
import { parseRemoteUrl } from "../src/scm.js";

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
});
