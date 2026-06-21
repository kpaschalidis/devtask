/**
 * Detect localhost-style dev-server URLs from PTY shell output.
 *
 * The Run script runs inside a PTY with `TERM=xterm-256color` and colour
 * forcing, so almost every framework prints its "ready" banner wrapped in
 * ANSI escape codes. We strip those first, then run a conservative regex
 * that only matches `http(s)://{localhost,127.0.0.1,0.0.0.0}[:PORT][/path]`
 * — the three host forms frameworks actually print for local dev.
 *
 * This is a best-effort, MVP-grade detector. It:
 *   - Covers Vite (`Local:   http://localhost:5173/`), Next.js, CRA,
 *     Rails-style banners, and plain `http://localhost:PORT` in prose.
 *   - Will not match `http://192.168.1.50:5173` (LAN) or custom domains.
 *   - Normalizes 127.0.0.1/0.0.0.0 → `localhost` (browsers choke on 0.0.0.0).
 *   - Strips trailing sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`).
 */

// Standard ANSI escape sequence pattern from the `ansi-regex` package (MIT).
// Covers CSI / OSC / operating-system commands and the BEL terminator.
// Constructed via `new RegExp(string)` so the formatter won't wrap a long
// literal — wrapping would push the biome-ignore out of range.
// biome-ignore lint/complexity/useRegexLiterals: literal form triggers noControlCharactersInRegex on unfixable lines
const ANSI_RE = new RegExp(
	"[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
	"g",
);

// Match http(s) URLs pointing at the three canonical local hosts. The path
// portion stops at whitespace, quotes, angle brackets, and closing parens —
// anything that's clearly URL-terminating in prose.
const LOCAL_URL_RE =
	/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`<>)\]]*)?/gi;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_RE, "");
}

/**
 * Extract normalized dev-server URLs from a chunk of shell output. Returns
 * URLs in the order they appear. Caller is responsible for deduping across
 * chunks (use {@link dedupUrlKey}).
 */
export function extractLocalUrls(input: string): string[] {
	const clean = stripAnsi(input);
	const matches = clean.match(LOCAL_URL_RE) ?? [];
	return matches.map(normalizeUrl);
}

/**
 * Canonical key used for deduping URLs. Collapses by origin
 * (`scheme://host:port`) so that different paths hitting the same dev
 * server — e.g. banner `http://localhost:5173/` and request log
 * `http://localhost:5173/api/users` — represent the same service and
 * only show up once in the Open menu. http vs https and different ports
 * stay distinct. Falls back to trailing-slash strip for URLs we can't
 * parse an origin from (shouldn't happen given our match regex).
 */
export function dedupUrlKey(url: string): string {
	const origin = url.match(/^(https?:\/\/[^/?#]+)/i);
	return origin ? origin[1].toLowerCase() : url.replace(/\/+$/, "");
}

/**
 * Extract the port number from a URL. Returns null if the URL omits the
 * port (defaulting to 80/443 via scheme isn't useful for the Run button).
 */
export function extractPort(url: string): number | null {
	const match = url.match(/:(\d+)(?=\/|$|\?|#)/);
	return match ? Number(match[1]) : null;
}

function normalizeUrl(raw: string): string {
	// Strip trailing sentence punctuation that's clearly not URL syntax.
	const trimmed = raw.replace(/[.,;:!?]+$/, "");
	// Rewrite wildcard/loopback hosts to the name browsers are happiest with.
	return trimmed.replace(/127\.0\.0\.1|0\.0\.0\.0/, "localhost");
}
