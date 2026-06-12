import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";

describe("cli registration", () => {
  it("does not register the generic session command", () => {
    const program = createCli();
    expect(program.commands.find((command) => command.name() === "session")).toBeUndefined();
  });
});
