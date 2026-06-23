import type { TranscriptFormat } from "./types";

// Maps provider IDs (from phase run records) to transcript formats.
// Add new providers here as devtask gains more adapters.
const PROVIDER_FORMAT_MAP: Record<string, TranscriptFormat> = {
	codex: "codex",
	cursor: "codex", // Cursor uses the same Codex JSONL session format
	"claude-code": "claude-code",
};

export function detectTranscriptFormat(
	provider: string | null | undefined,
	rawContent: string,
): TranscriptFormat {
	if (provider) {
		const mapped = PROVIDER_FORMAT_MAP[provider];
		if (mapped) return mapped;
	}
	return sniffFormat(rawContent);
}

// Content-based fallback for runs where provider is null or unrecognized.
function sniffFormat(content: string): TranscriptFormat {
	const firstLine = content.split("\n")[0]?.trim() ?? "";
	try {
		const obj = JSON.parse(firstLine) as Record<string, unknown>;
		if (obj.type === "session_meta") return "codex";
		if (obj.type === "tool_use" || obj.type === "thinking") return "claude-code";
	} catch {
		// not JSONL — fall through to raw
	}
	return "raw";
}
