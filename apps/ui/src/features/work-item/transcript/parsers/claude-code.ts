import type { TranscriptEntry } from "../types";

// ---------------------------------------------------------------------------
// Claude Code JSONL transcript parser (stub)
//
// Format: one JSON object per line with a top-level `type` field.
// Types to handle when implemented:
//   text         → { type: "text", text: "..." }
//   thinking     → { type: "thinking", thinking: "..." }  ← content is visible
//   tool_use     → { type: "tool_use", id, name, input: {...} }
//   tool_result  → { type: "tool_result", tool_use_id, content }
//
// Tool names differ from Codex:
//   Bash, Edit, Read, Write, Glob, Grep, LS, TodoWrite, ...
//
// This stub returns [] until Claude Code adapter support lands in devtask.
// ---------------------------------------------------------------------------

export function parseClaudeCodeTranscript(_content: string): TranscriptEntry[] {
	return [];
}
