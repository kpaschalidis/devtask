/**
 * Three-state lifecycle of a reasoning block — the presentational decision
 * the UI actually cares about. Derived once from the wire-format
 * `streaming` tri-state so components never reverse-engineer "streaming
 * is undefined = historical" themselves.
 *
 * Wire mapping (see `pipeline/accumulator/mod.rs::handle_assistant` and
 * `adapter/blocks.rs::parse_assistant_parts`):
 *   - `streaming === true`      → "streaming"     (active generation)
 *   - `streaming === false`     → "just-finished" (finalized in this live
 *                                                 session; keep open + show
 *                                                 "Thought for Ns")
 *   - `streaming === undefined` → "historical"    (DB reload; collapse by
 *                                                 default)
 *
 * Lives in `src/lib/` (zero-dep) so both `@/components/ai/reasoning` and
 * `@/features/panel/message-components/shared` can import it without
 * forming a circular dependency — and, more importantly, without each
 * side keeping its own copy that could silently drift when a fourth
 * state lands.
 */
export type ReasoningLifecycle = "streaming" | "just-finished" | "historical";

export function reasoningLifecycle(part: {
	streaming?: boolean;
}): ReasoningLifecycle {
	if (part.streaming === true) return "streaming";
	if (part.streaming === false) return "just-finished";
	return "historical";
}
