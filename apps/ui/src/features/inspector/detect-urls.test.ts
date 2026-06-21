import { describe, expect, it } from "vitest";
import {
	dedupUrlKey,
	extractLocalUrls,
	extractPort,
	stripAnsi,
} from "./detect-urls";

describe("stripAnsi", () => {
	it("strips color escape sequences", () => {
		const input = "\x1b[32mSuccess\x1b[0m";
		expect(stripAnsi(input)).toBe("Success");
	});

	it("strips bold + color combined", () => {
		const input =
			"\x1b[1;36mLocal:\x1b[0m \x1b[36mhttp://localhost:5173/\x1b[0m";
		expect(stripAnsi(input)).toBe("Local: http://localhost:5173/");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("no ansi here")).toBe("no ansi here");
	});
});

describe("extractLocalUrls — framework banners", () => {
	it("detects Vite's Local banner with trailing slash", () => {
		const input = `  VITE v5.0.0  ready in 150 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
`;
		expect(extractLocalUrls(input)).toEqual(["http://localhost:5173/"]);
	});

	it("detects Vite banner when wrapped in ANSI colors", () => {
		const input =
			"  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:5173/\x1b[39m\n";
		expect(extractLocalUrls(input)).toEqual(["http://localhost:5173/"]);
	});

	it("detects Next.js banner", () => {
		const input = `  ▲ Next.js 14.0.0
  - Local:        http://localhost:3000
  - Environments: .env.local

 ✓ Ready in 1.2s
`;
		expect(extractLocalUrls(input)).toEqual(["http://localhost:3000"]);
	});

	it("detects plain Express-style log", () => {
		expect(
			extractLocalUrls("Server listening at http://localhost:4000"),
		).toEqual(["http://localhost:4000"]);
	});
});

describe("extractLocalUrls — normalization", () => {
	it("rewrites 127.0.0.1 to localhost", () => {
		expect(extractLocalUrls("bound on http://127.0.0.1:8080")).toEqual([
			"http://localhost:8080",
		]);
	});

	it("rewrites 0.0.0.0 to localhost (browsers can't open 0.0.0.0)", () => {
		expect(extractLocalUrls("listening on http://0.0.0.0:8000")).toEqual([
			"http://localhost:8000",
		]);
	});

	it("strips trailing sentence punctuation", () => {
		expect(extractLocalUrls("visit http://localhost:3000.")).toEqual([
			"http://localhost:3000",
		]);
		expect(
			extractLocalUrls("running at http://localhost:3000, press q to quit"),
		).toEqual(["http://localhost:3000"]);
	});

	it("preserves paths", () => {
		expect(
			extractLocalUrls("dashboard at http://localhost:3000/admin/dashboard"),
		).toEqual(["http://localhost:3000/admin/dashboard"]);
	});

	it("preserves https", () => {
		expect(extractLocalUrls("HTTPS dev: https://localhost:5173/")).toEqual([
			"https://localhost:5173/",
		]);
	});
});

describe("extractLocalUrls — multiple + filtering", () => {
	it("returns multiple URLs in order", () => {
		const input = `
  API:      http://localhost:4000
  Frontend: http://localhost:5173/
`;
		expect(extractLocalUrls(input)).toEqual([
			"http://localhost:4000",
			"http://localhost:5173/",
		]);
	});

	it("ignores LAN IPs", () => {
		const input = `
  Local:    http://localhost:5173
  Network:  http://192.168.1.50:5173
`;
		expect(extractLocalUrls(input)).toEqual(["http://localhost:5173"]);
	});

	it("ignores non-http schemes", () => {
		expect(
			extractLocalUrls("ws://localhost:5173 and tcp://localhost:3000"),
		).toEqual([]);
	});

	it("returns [] for chunks with no URLs", () => {
		expect(extractLocalUrls("compiling...\nmodule loaded")).toEqual([]);
	});
});

describe("dedupUrlKey — origin-based collapse", () => {
	it("collapses trailing slash", () => {
		expect(dedupUrlKey("http://localhost:5173")).toBe(
			dedupUrlKey("http://localhost:5173/"),
		);
	});

	it("collapses different paths on the same origin to one service", () => {
		// This is the fix for the duplicate-row bug: a framework that prints
		// both a banner and a request log lands two URL strings with the
		// same host:port but different paths. They should collapse.
		expect(dedupUrlKey("http://localhost:5173/")).toBe(
			dedupUrlKey("http://localhost:5173/api/users"),
		);
	});

	it("keeps different ports distinct", () => {
		expect(dedupUrlKey("http://localhost:5173")).not.toBe(
			dedupUrlKey("http://localhost:3000"),
		);
	});

	it("keeps http and https on the same port distinct", () => {
		expect(dedupUrlKey("http://localhost:5173")).not.toBe(
			dedupUrlKey("https://localhost:5173"),
		);
	});

	it("is case-insensitive on scheme and host", () => {
		expect(dedupUrlKey("HTTP://LOCALHOST:5173")).toBe(
			dedupUrlKey("http://localhost:5173"),
		);
	});
});

describe("extractPort", () => {
	it("extracts explicit port", () => {
		expect(extractPort("http://localhost:5173")).toBe(5173);
		expect(extractPort("http://localhost:5173/")).toBe(5173);
		expect(extractPort("http://localhost:3000/admin?x=1")).toBe(3000);
	});

	it("returns null when port is omitted", () => {
		expect(extractPort("http://localhost/")).toBeNull();
		expect(extractPort("https://localhost")).toBeNull();
	});
});
