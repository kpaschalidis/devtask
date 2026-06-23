import { Suspense, useMemo, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	Cpu,
	Eye,
	FilePen,
	HelpCircle,
	Search,
	Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { detectTranscriptFormat } from "./detect";
import { parseTranscript } from "./parse";
import type { ToolCallEntry, ToolResultEntry, TranscriptEntry } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function TranscriptViewer({
	content,
	provider,
}: {
	content: string;
	provider: string | null | undefined;
}) {
	const format = useMemo(() => detectTranscriptFormat(provider, content), [provider, content]);
	const entries = useMemo(() => parseTranscript(content, format), [content, format]);

	// Map callId → tool-result so tool-call rows can render their output inline
	const resultMap = useMemo(() => {
		const map = new Map<string, ToolResultEntry>();
		for (const entry of entries) {
			if (entry.kind === "tool-result") map.set(entry.callId, entry);
		}
		return map;
	}, [entries]);

	// Fall back to raw text when format is unknown or parser yields nothing
	if (format === "raw" || entries.length === 0) {
		return (
			<pre className="max-h-[60vh] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
				{content}
			</pre>
		);
	}

	return (
		<div className="space-y-1.5">
			{entries.map((entry) => {
				// tool-results are rendered inline inside their tool-call row
				if (entry.kind === "tool-result") return null;
				return <EntryView key={entry.id} entry={entry} resultMap={resultMap} />;
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Entry dispatcher
// ---------------------------------------------------------------------------

function EntryView({
	entry,
	resultMap,
}: {
	entry: TranscriptEntry;
	resultMap: Map<string, ToolResultEntry>;
}) {
	switch (entry.kind) {
		case "task":
			return <TaskCard content={entry.content} />;
		case "text":
			return <TextBlock role={entry.role} content={entry.content} />;
		case "tool-call":
			return <ToolCallRow entry={entry} result={resultMap.get(entry.callId) ?? null} />;
		case "thinking":
			return <ThinkingRow />;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Task card — the initial prompt, collapsed by default
// ---------------------------------------------------------------------------

function TaskCard({ content }: { content: string }) {
	const [expanded, setExpanded] = useState(false);
	const firstLine = content.split("\n")[0] ?? content;

	return (
		<div className="rounded-lg border border-border/50 bg-muted/20">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
			>
				{expanded ? (
					<ChevronDown className="size-3 shrink-0 text-muted-foreground/50" />
				) : (
					<ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
				)}
				<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
					Task
				</span>
				{!expanded && (
					<span className="ml-1 truncate text-[11px] text-muted-foreground/70">
						{firstLine}
					</span>
				)}
			</button>
			{expanded && (
				<div className="border-t border-border/40 px-3 py-3">
					<pre className="max-h-[240px] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
						{content}
					</pre>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Text block — agent reasoning or user gate approval
// ---------------------------------------------------------------------------

function TextBlock({ role, content }: { role: "user" | "assistant"; content: string }) {
	if (role === "user") {
		return (
			<div className="rounded-lg border border-blue-200/40 bg-blue-50/30 px-4 py-3 dark:border-blue-900/30 dark:bg-blue-950/10">
				<div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-500/60">
					User
				</div>
				<p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
					{content}
				</p>
			</div>
		);
	}

	return (
		<div className="px-1 py-2 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-headings:mt-3 prose-headings:mb-1">
			<Suspense
				fallback={
					<p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
						{content}
					</p>
				}
			>
				<LazyStreamdown mode="static">{content}</LazyStreamdown>
			</Suspense>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Tool call row — shows the call + its result, collapsible
// ---------------------------------------------------------------------------

const CATEGORY_ICONS = {
	shell: Terminal,
	"file-edit": FilePen,
	"file-read": Eye,
	search: Search,
	process: Cpu,
	other: HelpCircle,
} satisfies Record<ToolCallEntry["category"], typeof Terminal>;

function ToolCallRow({
	entry,
	result,
}: {
	entry: ToolCallEntry;
	result: ToolResultEntry | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const Icon = CATEGORY_ICONS[entry.category] ?? HelpCircle;
	const hasOutput = Boolean(result?.output);
	const outputLines = result?.output.split("\n") ?? [];
	const PREVIEW_LINES = 5;

	return (
		<div className="rounded-md border border-border/40 bg-background overflow-hidden">
			{/* Call header */}
			<button
				type="button"
				onClick={() => hasOutput && setExpanded((v) => !v)}
				className={cn(
					"flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
					hasOutput ? "cursor-pointer hover:bg-accent/30" : "cursor-default",
				)}
			>
				<Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" />
				<div className="min-w-0 flex-1">
					<span className="text-[10px] font-medium text-muted-foreground/60 capitalize">
						{entry.name.replace(/_/g, " ")}
					</span>
					<div className="mt-0.5 truncate font-mono text-[11px] text-foreground/80">
						{entry.inputSummary}
					</div>
				</div>
				{hasOutput && (
					<span className="mt-0.5 shrink-0 text-muted-foreground/30">
						{expanded ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						)}
					</span>
				)}
				{!hasOutput && (
					<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/20" />
				)}
			</button>

			{/* Output panel */}
			{expanded && result && (
				<OutputPanel lines={outputLines} previewLines={PREVIEW_LINES} />
			)}
		</div>
	);
}

function OutputPanel({
	lines,
	previewLines,
}: {
	lines: string[];
	previewLines: number;
}) {
	const [showAll, setShowAll] = useState(false);
	const visible = showAll ? lines : lines.slice(0, previewLines);
	const hasMore = lines.length > previewLines;

	return (
		<div className="border-t border-border/40 bg-muted/20 px-3 py-2.5">
			<pre className="font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
				{visible.join("\n")}
			</pre>
			{hasMore && !showAll && (
				<button
					type="button"
					onClick={() => setShowAll(true)}
					className="mt-1.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
				>
					Show {lines.length - previewLines} more lines…
				</button>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Thinking row — encrypted reasoning placeholder
// ---------------------------------------------------------------------------

function ThinkingRow() {
	return (
		<div className="flex items-center gap-2 px-3 py-1.5">
			<Cpu className="size-3 shrink-0 text-muted-foreground/30" />
			<span className="text-[11px] italic text-muted-foreground/40">Reasoning…</span>
		</div>
	);
}
