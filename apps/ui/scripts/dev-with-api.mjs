import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(uiRoot, "..", "..");
const apiPort = process.env.DEVTASK_API_PORT ?? "43210";
const uiPort = process.env.DEVTASK_UI_PORT ?? "1420";
const apiBase = process.env.DEVTASK_API_BASE ?? `http://127.0.0.1:${apiPort}`;

const children = [];

function start(name, command, args, cwd, extraEnv = {}) {
	const child = spawn(command, args, {
		cwd,
		env: { ...process.env, ...extraEnv },
		stdio: "inherit",
	});
	children.push(child);
	child.on("exit", (code, signal) => {
		if (signal || code !== 0) {
			shutdown(typeof code === "number" ? code : 1);
			return;
		}
	});
	return child;
}

function shutdown(code = 0) {
	for (const child of children) {
		if (!child.killed) {
			child.kill("SIGTERM");
		}
	}
	process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

start(
	"devtask-api",
	"npx",
	[
		"-p",
		"node@22",
		"-c",
		`node dist/bin/devtask.js serve --host 127.0.0.1 --port ${apiPort}`,
	],
	repoRoot,
);

start(
	"vite",
	"npx",
	[
		"vite",
		"--configLoader",
		"runner",
		"--host",
		"127.0.0.1",
		"--port",
		uiPort,
	],
	uiRoot,
	{ VITE_DEVTASK_API_BASE: apiBase },
);
