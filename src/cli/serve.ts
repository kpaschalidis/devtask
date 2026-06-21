import { Command } from "commander";
import { startApiServer } from "../server/api.js";
import { printError } from "./common.js";

export function registerServeCommands(program: Command): void {
  program
    .command("serve")
    .description("Serve the devtask local API for desktop and other clients.")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port")
    .action(async (options: { host: string; port?: string }) => {
      try {
        const server = await startApiServer({
          host: options.host,
          port: options.port ? Number.parseInt(options.port, 10) : undefined,
        });
        console.log(`Devtask API server: ${server.url}`);
        console.log("Press Ctrl+C to stop");
      } catch (error) {
        printError(error);
      }
    });
}
