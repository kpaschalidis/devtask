import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";

describe("cli registration", () => {
  it("does not register the generic session command", () => {
    const program = createCli();
    expect(program.commands.find((command) => command.name() === "session")).toBeUndefined();
  });

  it("registers work lessons subcommands", () => {
    const program = createCli();
    const work = program.commands.find((c) => c.name() === "work");
    expect(work).toBeDefined();
    const lessons = work!.commands.find((c) => c.name() === "lessons");
    expect(lessons).toBeDefined();
    const subNames = lessons!.commands.map((c) => c.name());
    expect(subNames).toContain("list");
    expect(subNames).toContain("approve");
    expect(subNames).toContain("reject");
  });
});
