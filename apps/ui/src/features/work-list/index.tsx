// Work list table view — default center screen for the work-first shell.
// Shows all work items (or a view/project-filtered subset) as a table.
// Selecting a row navigates to the work detail screen.
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { DevtaskWorkListEntry } from "@/lib/devtask-api";
import { devtaskWorkListQueryOptions } from "@/lib/devtask-query-client";
import {
	filterWorkByNavView,
	formatRelativeTime,
	type NavView,
	statusToPhase,
} from "@/lib/devtask-projections";
import { cn } from "@/lib/utils";
import { router } from "@/router";

type WorkListViewProps = {
	workspaceId: string | null;
	navView: string | null;
	project: string | null;
	headerLeading?: React.ReactNode;
};

export const WorkListView = memo(function WorkListView({
	workspaceId,
	navView,
	project,
	headerLeading,
}: WorkListViewProps) {
	const { data, isPending } = useQuery(devtaskWorkListQueryOptions());
	const [search, setSearch] = useState("");

	const allWork = data?.work ?? [];
	const workspaceName = data?.workspaceName ?? null;

	// Determine if we're viewing a specific project/workspace
	const isProjectView = Boolean(project);
	// All work belongs to the single workspace, so project filter = show all
	// (future: filter by project when multi-workspace is supported)
	const workForView = useMemo(() => {
		let result = filterWorkByNavView(allWork, navView as NavView | null);
		if (search.trim()) {
			const q = search.trim().toLowerCase();
			result = result.filter(
				(item) =>
					item.title.toLowerCase().includes(q) ||
					item.id.toLowerCase().includes(q) ||
					item.status.toLowerCase().includes(q),
			);
		}
		return result;
	}, [allWork, navView, search]);

	function handleSelectWork(workId: string) {
		if (!workspaceId) return;
		void router.navigate({
			to: "/w/$workspaceId/work/$workId",
			params: { workspaceId, workId },
			search: { view: "conversation" },
			replace: true,
		});
	}

	// Header title
	const viewTitle = isProjectView
		? (workspaceName ?? project ?? "Project")
		: navView
			? NAV_VIEW_LABELS[navView] ?? "Work"
			: "All work";

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-panel">
			{/* Compact header */}
			<div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-5 py-3">
				<div className="flex min-w-0 items-center gap-2.5">
					{headerLeading}
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-semibold text-foreground">
							{viewTitle}
						</span>
						{isProjectView && (
							<span className="text-xs text-muted-foreground">
								{workForView.length} items
							</span>
						)}
						{!isProjectView && workForView.length > 0 && (
							<Badge
								variant="secondary"
								className="h-4 rounded px-1.5 text-[11px] tabular-nums font-normal"
							>
								{workForView.length}
							</Badge>
						)}
					</div>
				</div>
				<div className="relative ml-auto w-52 shrink-0">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search work…"
						className="h-7 pl-7 text-xs"
					/>
				</div>
			</div>

			{/* Work table */}
			<div className="min-h-0 flex-1 overflow-auto">
				{isPending ? (
					<div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
						Loading…
					</div>
				) : workForView.length === 0 ? (
					<EmptyState navView={navView} isProjectView={isProjectView} hasSearch={Boolean(search)} />
				) : (
					<WorkTable
						rows={workForView}
						workspaceName={workspaceName}
						onSelectWork={handleSelectWork}
					/>
				)}
			</div>
		</div>
	);
});

const NAV_VIEW_LABELS: Record<string, string> = {
	active: "Active",
	"needs-you": "Needs you",
	shipped: "Shipped",
};

// ---------------------------------------------------------------------------
// Work table
// ---------------------------------------------------------------------------

function WorkTable({
	rows,
	workspaceName,
	onSelectWork,
}: {
	rows: DevtaskWorkListEntry[];
	workspaceName: string | null;
	onSelectWork: (workId: string) => void;
}) {
	return (
		<table className="w-full min-w-[680px] text-sm">
			<thead className="sticky top-0 z-10 border-b border-border/60 bg-panel">
				<tr>
					<Th className="w-24 pl-5">ID</Th>
					<Th>Title</Th>
					<Th className="w-24">Phase</Th>
					<Th className="w-28">Status</Th>
					<Th className="w-36">Project · Repo</Th>
					<Th className="w-24 pr-5">Updated</Th>
				</tr>
			</thead>
			<tbody>
				{rows.map((item) => (
					<WorkRow
						key={item.id}
						item={item}
						workspaceName={workspaceName}
						onSelect={onSelectWork}
					/>
				))}
			</tbody>
		</table>
	);
}

function WorkRow({
	item,
	workspaceName,
	onSelect,
}: {
	item: DevtaskWorkListEntry;
	workspaceName: string | null;
	onSelect: (workId: string) => void;
}) {
	const phase = statusToPhase(item.status);
	const shortId = item.id.length > 10 ? `${item.id.slice(0, 10)}…` : item.id;
	const projectRepo = workspaceName
		? `${workspaceName} · ${item.sourceType || "-"}`
		: item.sourceType || "-";

	return (
		<tr
			onClick={() => onSelect(item.id)}
			className="cursor-pointer border-b border-border/30 transition-colors hover:bg-accent/30"
		>
			<td className="py-2.5 pl-5 pr-3">
				<span className="font-mono text-[11px] text-muted-foreground">
					{shortId}
				</span>
			</td>
			<td className="px-3 py-2.5">
				<span className="line-clamp-1 text-sm font-medium text-foreground">
					{item.title}
				</span>
			</td>
			<td className="px-3 py-2.5">
				<span className="capitalize text-xs text-muted-foreground">{phase}</span>
			</td>
			<td className="px-3 py-2.5">
				<StatusBadge status={item.status} />
			</td>
			<td className="px-3 py-2.5">
				<span className="truncate text-xs text-muted-foreground">{projectRepo}</span>
			</td>
			<td className="py-2.5 pl-3 pr-5">
				<span className="whitespace-nowrap text-xs text-muted-foreground">
					{formatRelativeTime(item.updatedAt)}
				</span>
			</td>
		</tr>
	);
}

function Th({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<th
			className={cn(
				"px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60",
				className,
			)}
		>
			{children}
		</th>
	);
}

function StatusBadge({ status }: { status: string }) {
	const variant = statusVariant(status);
	return (
		<span
			className={cn(
				"inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize",
				variant === "running" &&
					"bg-blue-500/10 text-blue-600 dark:text-blue-400",
				variant === "done" &&
					"bg-green-500/10 text-green-600 dark:text-green-400",
				variant === "attention" &&
					"bg-red-500/10 text-red-600 dark:text-red-400",
				variant === "default" && "bg-muted/60 text-muted-foreground",
			)}
		>
			{status}
		</span>
	);
}

function statusVariant(
	status: string,
): "running" | "done" | "attention" | "default" {
	if (status.includes("running") || status.includes("execut")) return "running";
	if (status.includes("done") || status.includes("passed")) return "done";
	if (status.includes("failed") || status.includes("blocked")) return "attention";
	return "default";
}

function EmptyState({
	navView,
	isProjectView,
	hasSearch,
}: {
	navView: string | null;
	isProjectView: boolean;
	hasSearch: boolean;
}) {
	let message = "No work items.";
	if (hasSearch) {
		message = "No items match your search.";
	} else if (isProjectView) {
		message = "No work items in this project.";
	} else if (navView === "active") {
		message = "No active work.";
	} else if (navView === "needs-you") {
		message = "Nothing waiting for your input.";
	} else if (navView === "shipped") {
		message = "Nothing shipped yet.";
	}

	return (
		<div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
			{message}
		</div>
	);
}
