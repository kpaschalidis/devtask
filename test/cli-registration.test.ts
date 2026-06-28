import { describe, expect, it } from "vitest";
import { createCli } from "../apps/cli/src/cli.js";

describe("cli registration", () => {
  it("does not register the generic session command", () => {
    const program = createCli();
    expect(program.commands.find((command) => command.name() === "session")).toBeUndefined();
  });

  it("does not register the removed work lessons command", () => {
    const program = createCli();
    const work = program.commands.find((c) => c.name() === "work");
    expect(work).toBeDefined();
    const lessons = work!.commands.find((c) => c.name() === "lessons");
    expect(lessons).toBeUndefined();
  });
});
