import type { TranscriptEntry, TranscriptFormat } from "./types";
import { parseCodexTranscript } from "./parsers/codex";
import { parseClaudeCodeTranscript } from "./parsers/claude-code";

export function parseTranscript(
	content: string,
	format: TranscriptFormat,
): TranscriptEntry[] {
	switch (format) {
		case "codex":
			return parseCodexTranscript(content);
		case "claude-code":
			return parseClaudeCodeTranscript(content);
		case "raw":
			return [];
	}
}
