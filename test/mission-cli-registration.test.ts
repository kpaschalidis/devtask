import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWorkCommands } from "../src/cli/work.js";
import { createCli } from "../src/cli.js";

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
