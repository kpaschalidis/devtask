import type { TranscriptEntry, ToolCategory } from "../types";

// ---------------------------------------------------------------------------
// Codex JSONL transcript parser
//
// Format: one JSON object per line. Only "response_item" lines carry content.
// response_item.payload.type values we handle:
//   message          → role: user | assistant | developer
//   function_call    → { name, call_id, arguments (JSON string) }
//   function_call_output → { call_id, output }
//   custom_tool_call → { name, call_id, input (patch text) | arguments (JSON string) }
//   custom_tool_call_output → { call_id, output }
//   reasoning        → encrypted, content not accessible
// ---------------------------------------------------------------------------

type MessageContent = Array<{ type: string; text?: string }> | string;

function extractMessageText(content: MessageContent): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c.type === "output_text" || c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// Codex CLI output cleaning
//
// exec_command output always leads with Codex CLI metadata before actual content:
//   Chunk ID: f43b25
//   Wall time: 1.0009 seconds
//   Process running with session ID 73056   (or: Process exited with code 0)
//   Original token count: 359
//   Output:
//   <actual output here>
//
// We strip everything up to and including the "Output:" / "Output (truncated):"
// marker so the UI only shows the real command output.
// ---------------------------------------------------------------------------

const CODEX_OUTPUT_MARKER = /^Output(?: \(truncated\))?:\s*\n/m;
const CODEX_META_LINE = /^(?:Chunk ID:|Wall time:|Process (?:running|exited) with|Original token count:|Output(?: \(truncated\))?:)/;

function cleanCodexOutput(raw: string): string {
	const markerMatch = CODEX_OUTPUT_MARKER.exec(raw);
	if (markerMatch) {
		return raw.slice(markerMatch.index + markerMatch[0].length);
	}
	// Fallback: strip leading metadata lines one-by-one
	const lines = raw.split("\n");
	const firstContent = lines.findIndex((l) => !CODEX_META_LINE.test(l));
	if (firstContent > 0) {
		return lines.slice(firstContent).join("\n");
	}
	return raw;
}

function parseArgs(argumentsStr: string): Record<string, unknown> {
	try {
		return JSON.parse(argumentsStr) as Record<string, unknown>;
	} catch {
		return {};
	}
}

type ToolDescription = {
	category: ToolCategory;
	inputSummary: string;
	inputDetail: string | null;
};

function describeShellCommand(args: Record<string, unknown>): ToolDescription {
	const cmd = String(args.cmd ?? args.command ?? "");
	return {
		category: "shell",
		inputSummary: cmd.length > 100 ? `${cmd.slice(0, 97)}…` : cmd,
		inputDetail: cmd,
	};
}

function describePatch(patchText: string): ToolDescription {
	const files = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
		(m) => m[1].split("/").at(-1) ?? m[1],
	);
	const summary =
		files.length > 0
			? files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3} more` : "")
			: "apply patch";
	return { category: "file-edit", inputSummary: summary, inputDetail: patchText };
}

function describeProcessInput(args: Record<string, unknown>): ToolDescription {
	const chars = String(args.chars ?? "");
	const display = chars.trim() ? chars.slice(0, 40) : "(empty)";
	return {
		category: "process",
		inputSummary: `→ session ${args.session_id ?? "?"}: ${display}`,
		inputDetail: null,
	};
}

function describeTool(
	name: string,
	args: Record<string, unknown>,
	rawInput?: string,
): ToolDescription {
	switch (name) {
		case "exec_command":
		case "bash":
		case "run_command":
			return describeShellCommand(args);

		case "apply_patch":
			return describePatch(rawInput ?? JSON.stringify(args));

		case "write_stdin":
			return describeProcessInput(args);

		case "read_file":
		case "cat":
		case "open_file": {
			const path = String(args.path ?? args.file ?? "");
			return { category: "file-read", inputSummary: path, inputDetail: null };
		}

		case "grep":
		case "search":
		case "find": {
			const pattern = String(args.pattern ?? args.query ?? args.cmd ?? "");
			return { category: "search", inputSummary: pattern, inputDetail: null };
		}

		default:
			return {
				category: "other",
				inputSummary: name,
				inputDetail: Object.keys(args).length ? JSON.stringify(args, null, 2) : null,
			};
	}
}

export function parseCodexTranscript(content: string): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	let idx = 0;
	let firstUserSeen = false;

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (obj.type !== "response_item") continue;

		const payload = obj.payload as Record<string, unknown> | undefined;
		if (!payload) continue;

		const payloadType = String(payload.type ?? "");
		const id = `codex-${idx++}`;

		switch (payloadType) {
			case "message": {
				const role = String(payload.role ?? "");
				if (role === "developer") break; // system prompt — skip

				const text = extractMessageText(payload.content as MessageContent);
				if (!text.trim()) break;

				if (role === "user" && !firstUserSeen) {
					firstUserSeen = true;
					entries.push({ kind: "task", id, content: text });
				} else if (role === "user") {
					// Gate approvals / follow-up messages
					entries.push({ kind: "text", id, role: "user", content: text });
				} else if (role === "assistant") {
					entries.push({ kind: "text", id, role: "assistant", content: text });
				}
				break;
			}

			case "function_call": {
				const name = String(payload.name ?? "");
				const callId = String(payload.call_id ?? id);
				const args = parseArgs(String(payload.arguments ?? "{}"));
				const desc = describeTool(name, args);
				entries.push({ kind: "tool-call", id, callId, name, ...desc });
				break;
			}

			case "function_call_output": {
				const callId = String(payload.call_id ?? "");
				const output = cleanCodexOutput(String(payload.output ?? ""));
				entries.push({ kind: "tool-result", id, callId, output, success: true });
				break;
			}

			case "custom_tool_call": {
				const name = String(payload.name ?? "");
				const callId = String(payload.call_id ?? id);
				// apply_patch uses `input` (raw patch text), not `arguments`
				const rawInput = typeof payload.input === "string" ? payload.input : undefined;
				const args = rawInput ? {} : parseArgs(String(payload.arguments ?? "{}"));
				const desc = describeTool(name, args, rawInput);
				entries.push({ kind: "tool-call", id, callId, name, ...desc });
				break;
			}

			case "custom_tool_call_output": {
				const callId = String(payload.call_id ?? "");
				const output = String(payload.output ?? "");
				entries.push({ kind: "tool-result", id, callId, output, success: true });
				break;
			}

			case "reasoning": {
				// Content is always encrypted in Codex — show a placeholder
				entries.push({ kind: "thinking", id, content: null });
				break;
			}
		}
	}

	return entries;
}
