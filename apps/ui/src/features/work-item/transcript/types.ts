export type TranscriptFormat = "codex" | "claude-code" | "raw";

export type ToolCategory = "shell" | "file-edit" | "file-read" | "search" | "process" | "other";

export type TaskEntry = {
	kind: "task";
	id: string;
	content: string;
};

export type TextEntry = {
	kind: "text";
	id: string;
	role: "user" | "assistant";
	content: string;
};

export type ToolCallEntry = {
	kind: "tool-call";
	id: string;
	callId: string;
	name: string;
	category: ToolCategory;
	inputSummary: string;
	inputDetail: string | null;
};

export type ToolResultEntry = {
	kind: "tool-result";
	id: string;
	callId: string;
	output: string;
	success: boolean;
};

export type ThinkingEntry = {
	kind: "thinking";
	id: string;
	content: string | null; // null = encrypted (Codex), string = visible (Claude Code)
};

export type TranscriptEntry =
	| TaskEntry
	| TextEntry
	| ToolCallEntry
	| ToolResultEntry
	| ThinkingEntry;
