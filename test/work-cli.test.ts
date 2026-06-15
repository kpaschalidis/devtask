import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWorkCommands } from "../src/cli/work.js";

describe("work CLI", () => {
  it("registers materialize, pr-watch, runs, diagnose, inspect, and removes implement", () => {
    const program = new Command();

    registerWorkCommands(program);

    const work = program.commands.find((command) => command.name() === "work");
    const subcommandNames = work?.commands.map((command) => command.name()) ?? [];

    expect(subcommandNames).toContain("execute");
    expect(subcommandNames).toContain("compound");
    expect(subcommandNames).toContain("materialize");
    expect(subcommandNames).toContain("pr-watch");
    expect(subcommandNames).toContain("runs");
    expect(subcommandNames).toContain("diagnose");
    expect(subcommandNames).toContain("inspect");
    expect(subcommandNames).not.toContain("implement");
  });
});
