import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBoardCommands } from "../src/cli/board.js";

describe("board CLI", () => {
  it("registers html and work subcommands", () => {
    const program = new Command();

    registerBoardCommands(program);

    const board = program.commands.find((command) => command.name() === "board");
    const subcommandNames = board?.commands.map((command) => command.name()) ?? [];

    expect(subcommandNames).toContain("html");
    expect(subcommandNames).toContain("serve");
    expect(subcommandNames).toContain("work");
  });
});
