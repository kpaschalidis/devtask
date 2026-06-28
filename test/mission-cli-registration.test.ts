import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createCli } from "../apps/cli/src/cli.js";
import { registerWorkCommands } from "../apps/cli/src/commands/work.js";

describe("work mission commands", () => {
  it("registers approve, stop, and _validate-worker commands", () => {
    const program = new Command();
    registerWorkCommands(program);

    const work = program.commands.find((c) => c.name() === "work");
    const names = work?.commands.map((c) => c.name()) ?? [];

    expect(names).toContain("approve");
    expect(names).toContain("stop");
    expect(names).toContain("_validate-worker");
  });
});

describe("agent command registration", () => {
  it("registers agent as a top-level command", () => {
    const program = createCli();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("agent");
  });
});
