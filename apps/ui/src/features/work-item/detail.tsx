import { useQuery } from "@tanstack/react-query";
import {
	CheckCircle2,
	Circle,
	ExternalLink,
	FileText,
	ListChecks,
	Loader2,
	MessagesSquare,
	XCircle,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DevtaskWorkDetail, DevtaskWorkGraph, DevtaskWorkGraphFeature, DevtaskWorkGraphTask } from "@/lib/devtask-api";
import { loadDevtaskFileContent, type DevtaskFileEntry } from "@/lib/devtask-api";
import {
	devtaskWorkDetailQueryOptions,
} from "@/lib/devtask-query-client";
import { formatRelativeTime } from "@/lib/devtask-projections";
import { cn } from "@/lib/utils";
import { TranscriptViewer } from "./transcript";

type WorkItemDetailProps = {
	workId: string | null;
	selectedSessionThreadId?: string | null;
	selectedArtifactId?: string | null;
	onSelectSession?: (threadId: string) => void;
	onOpenArtifact?: (path: string) => void;
	headerLeading?: React.ReactNode;
	headerActions?: React.ReactNode;
};

type SectionId = "overview" | "tasks" | "artifacts" | "sessions" | "validation";

export const WorkItemDetail = memo(function WorkItemDetail({
	workId,
	selectedSessionThreadId = null,
	selectedArtifactId = null,
	onOpenArtifact,
	headerLeading,
	headerActions,
}: WorkItemDetailProps) {
	const detailQuery = useQuery({
		...devtaskWorkDetailQueryOptions(workId ?? "__none__"),
		enabled: Boolean(workId),
	});

	const detail = detailQuery.data ?? null;
	const routeSection: SectionId = selectedSessionThreadId
		? "sessions"
		: selectedArtifactId
			? "artifacts"
			: "overview";
	const [manualSection, setManualSection] = useState<SectionId | null>(null);
	const activeSection = manualSection ?? routeSection;

	if (!workId) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-panel px-8 text-sm text-muted-foreground">
				Select a work item
			</div>
		);
	}

	if (detailQuery.isPending) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-panel px-8 text-sm text-muted-foreground">
				Loading work item…
			</div>
		);
	}

	if (!detail) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-panel px-8 text-sm text-destructive">
				Unable to load work item.
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-panel">
			{/* Compact header */}
			<div className="shrink-0 border-b border-border/60 px-4 py-2.5">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						{headerLeading}
						<div className="min-w-0">
							<div className="truncate text-sm font-semibold text-foreground">
								{detail.item.source.title}
							</div>
							<div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span className="font-mono">{detail.item.id}</span>
								<span>·</span>
								<span>{detail.item.status}</span>
								<span>·</span>
								<span>{detail.item.source.type}</span>
								{detail.graph && (
									<span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", KIND_BADGE_STYLES[detail.graph.kind] ?? "bg-muted text-muted-foreground")}>
										{detail.graph.kind}
									</span>
								)}
							</div>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{headerActions}
					</div>
				</div>
				{/* Section tabs */}
				<div className="mt-2 flex flex-wrap gap-1">
					{(
						[
							{ id: "overview" as const, icon: FileText, label: "Overview" },
							{ id: "tasks" as const, icon: ListChecks, label: "Tasks" },
							{ id: "artifacts" as const, icon: FileText, label: "Artifacts" },
							{ id: "validation" as const, icon: CheckCircle2, label: "Validation" },
							{ id: "sessions" as const, icon: MessagesSquare, label: "Sessions" },
						] as const
					).map(({ id, icon: Icon, label }) => (
						<SectionButton
							key={id}
							active={activeSection === id}
							icon={Icon}
							label={label}
							onClick={() => setManualSection(id)}
						/>
					))}
				</div>
			</div>

			{/* Three-rail body */}
			<div className="flex min-h-0 flex-1">
				{/* Left lifecycle rail */}
				<div className="w-40 shrink-0 overflow-y-auto border-r border-border/60 bg-panel px-3 py-4">
					<LifecycleRail detail={detail} />
				</div>

				{/* Center content */}
				<div className="min-h-0 flex-1 overflow-auto px-4 py-4">
					<CenterContent
						detail={detail}
						section={activeSection}
						onOpenArtifact={onOpenArtifact}
					/>
				</div>

				{/* Right activity rail */}
				<div className="w-56 shrink-0 overflow-y-auto border-l border-border/60 bg-panel px-3 py-4">
					<ActivityRail detail={detail} />
				</div>
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Lifecycle rail
// ---------------------------------------------------------------------------

const LIFECYCLE_PHASES = [
	"spec",
	"plan",
	"impl",
	"validate",
	"review",
	"pr",
] as const;
type Phase = (typeof LIFECYCLE_PHASES)[number];

// Ordered work item statuses from earliest to latest
const STATUS_ORDER = [
	"created",
	"planned",
	"materialized",
	"executing",
	"review-ready",
	"pr-open",
	"completed",
] as const;

function statusIndex(status: string): number {
	return STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
}

function resolvePhaseStatus(
	phase: Phase,
	detail: DevtaskWorkDetail,
): "done" | "running" | "pending" | "blocked" {
	const status = detail.item.status.toLowerCase();
	const idx = statusIndex(status);
	const g1 = detail.status.gate1?.status ?? null;
	const g2 = detail.status.gate2?.status ?? null;
	const running = detail.status.orchestratorSession.running;

	if (phase === "spec") {
		const hasSpec = detail.inspection.artifacts.some(
			(a) => a.label.toLowerCase().includes("spec") && a.exists,
		);
		if (hasSpec || idx >= 1) return "done";
		return running ? "running" : "pending";
	}
	if (phase === "plan") {
		const hasPlan = detail.inspection.artifacts.some(
			(a) => a.label.toLowerCase().includes("plan") && a.exists,
		);
		if (hasPlan || idx >= 2) return "done";
		return idx === 1 && running ? "running" : "pending";
	}
	if (phase === "impl") {
		if (idx >= 4) return "done"; // review-ready or beyond
		if (g1 === "approved") return "done";
		if (idx === 3) return running ? "running" : "pending"; // executing
		if (g1 === "pending" || g1 === "waiting") return running ? "running" : "pending";
		return "pending";
	}
	if (phase === "validate") {
		const vr = detail.status.validatorResults;
		if (vr.length > 0 && vr.every((r) => r.status === "passed")) return "done";
		if (vr.some((r) => r.status === "failed")) return "blocked";
		if (g2 === "approved" || idx >= 5) return "done";
		return "pending";
	}
	if (phase === "review") {
		if (idx >= 5) return "done"; // pr-open or beyond means review is done
		const hasReview = detail.inspection.artifacts.some(
			(a) => a.label.toLowerCase().includes("review") && a.exists,
		);
		if (hasReview) return "done";
		return idx === 4 && running ? "running" : "pending"; // review-ready
	}
	if (phase === "pr") {
		if (status === "completed") return "done";
		if (status === "pr-open") return "running"; // PR is open, not yet merged
		return "pending";
	}
	return "pending";
}

function LifecycleRail({ detail }: { detail: DevtaskWorkDetail }) {
	return (
		<div className="space-y-0.5">
			<div className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
				Lifecycle
			</div>
			{LIFECYCLE_PHASES.map((phase) => {
				const phaseStatus = resolvePhaseStatus(phase, detail);
				return (
					<div key={phase} className="flex items-center gap-2 py-1">
						<PhaseStatusIcon status={phaseStatus} />
						<span
							className={cn(
								"text-xs capitalize",
								phaseStatus === "done"
									? "text-muted-foreground/70"
									: phaseStatus === "running"
										? "font-medium text-foreground"
										: phaseStatus === "blocked"
											? "text-destructive"
											: "text-muted-foreground/50",
							)}
						>
							{phase}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function PhaseStatusIcon({
	status,
}: {
	status: "done" | "running" | "pending" | "blocked";
}) {
	if (status === "done") {
		return <CheckCircle2 className="size-3 shrink-0 text-green-500" />;
	}
	if (status === "running") {
		return <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />;
	}
	if (status === "blocked") {
		return <XCircle className="size-3 shrink-0 text-destructive" />;
	}
	return <Circle className="size-3 shrink-0 text-muted-foreground/30" />;
}

// ---------------------------------------------------------------------------
// Right activity rail
// ---------------------------------------------------------------------------

function normalizeRunStatus(runStatus: string, orchestratorRunning: boolean): string {
	// Phase runs stored as in-progress states with an idle orchestrator are stale.
	if (!orchestratorRunning && (runStatus === "running" || runStatus === "planned" || runStatus === "queued")) {
		return "done";
	}
	return runStatus;
}

function ActivityRail({ detail }: { detail: DevtaskWorkDetail }) {
	const liveSessions = detail.inspection.livePhaseSessions;
	const orchestratorRunning = detail.status.orchestratorSession.running;
	const latestRuns = detail.inspection.latestPhaseRuns.slice(0, 4);
	// Don't show stale blocked tasks once the work has progressed past execution
	const workIdx = statusIndex(detail.item.status);
	const problems = workIdx >= statusIndex("pr-open") ? [] : detail.inspection.problemTasks;

	return (
		<div className="space-y-5">
			{/* Orchestrator */}
			<div>
				<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
					Orchestrator
				</div>
				<div className="flex items-center gap-1.5 text-xs">
					{detail.status.orchestratorSession.running ? (
						<>
							<Loader2 className="size-3 animate-spin text-blue-500" />
							<span className="text-foreground">Running</span>
						</>
					) : (
						<>
							<Circle className="size-3 text-muted-foreground/30" />
							<span className="text-muted-foreground">Idle</span>
						</>
					)}
				</div>
			</div>

			{/* Live sessions */}
			{liveSessions.length > 0 && (
				<div>
					<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
						Live sessions
					</div>
					<div className="space-y-1.5">
						{liveSessions.map((session, i) => (
							<div
								key={`${session.phase}:${session.taskId ?? i}`}
								className="rounded-md border border-border/50 bg-background px-2.5 py-2"
							>
								<div className="flex items-center gap-1.5">
									<Loader2 className="size-2.5 shrink-0 animate-spin text-blue-500" />
									<span className="truncate text-xs font-medium">
										{session.phase}
									</span>
								</div>
								{session.taskId && (
									<div className="mt-0.5 text-[10px] text-muted-foreground truncate">
										{session.repoId} / {session.taskId}
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Recent activity */}
			{latestRuns.length > 0 && (
				<div>
					<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
						Recent activity
					</div>
					<div className="space-y-1.5">
						{latestRuns.map((run, i) => {
							const displayStatus = normalizeRunStatus(run.status, orchestratorRunning);
							return (
							<div key={i} className="rounded-md border border-border/40 bg-background px-2.5 py-2">
								<div className="flex items-center justify-between gap-1">
									<span className="truncate text-xs font-medium capitalize">
										{run.phase}
									</span>
									<span
										className={cn(
											"shrink-0 rounded px-1 py-0.5 text-[10px]",
											displayStatus === "passed" || displayStatus === "done"
												? "bg-green-500/10 text-green-600 dark:text-green-400"
												: displayStatus === "failed"
													? "bg-red-500/10 text-red-600 dark:text-red-400"
													: "bg-muted text-muted-foreground",
										)}
									>
										{displayStatus}
									</span>
								</div>
								{run.taskId && (
									<div className="mt-0.5 truncate text-[10px] text-muted-foreground">
										{run.taskId}
									</div>
								)}
							</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Problem tasks */}
			{problems.length > 0 && (
				<div>
					<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
						Blocked
					</div>
					<div className="space-y-1.5">
						{problems.slice(0, 3).map((task) => (
							<div
								key={`${task.repoId}:${task.taskId}`}
								className="rounded-md border border-red-200/60 bg-red-50/40 px-2.5 py-2 dark:border-red-900/40 dark:bg-red-950/20"
							>
								<div className="truncate text-xs font-medium text-destructive">
									{task.taskId}
								</div>
								<div className="mt-0.5 truncate text-[10px] text-muted-foreground">
									{task.reason ?? task.status}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_BADGE_STYLES: Record<DevtaskWorkGraph["kind"], string> = {
	feature: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	bugfix: "bg-red-500/10 text-red-600 dark:text-red-400",
	refactor: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

// ---------------------------------------------------------------------------
// Center content sections
// ---------------------------------------------------------------------------

function CenterContent({
	detail,
	section,
	onOpenArtifact,
}: {
	detail: DevtaskWorkDetail;
	section: SectionId;
	onOpenArtifact?: (path: string) => void;
}) {
	if (section === "overview") {
		const openQuestions = detail.graph?.openQuestions ?? [];
		const body = detail.item.source.body?.trim() ?? "";
		return (
			<div className="grid gap-4 md:grid-cols-2">
				{body && (
					<div className="md:col-span-2">
						<InfoCard title="Description">
							<p className="whitespace-pre-wrap text-sm text-muted-foreground leading-relaxed">{body}</p>
						</InfoCard>
					</div>
				)}
				<InfoCard title="Status">
					<Row label="State" value={detail.item.status} />
					<Row label="Waiting on" value={detail.diagnostics.waitingOn} />
					<Row label="Next" value={detail.diagnostics.next} />
					<Row label="Updated" value={formatRelativeTime(detail.item.updatedAt)} />
				</InfoCard>
				<InfoCard title="Orchestration">
					<Row
						label="Orchestrator"
						value={detail.status.orchestratorSession.running ? "running" : "idle"}
					/>
					<Row label="Gate 1" value={detail.status.gate1?.status ?? "not set"} />
					<Row label="Gate 2" value={detail.status.gate2?.status ?? "not set"} />
					<Row
						label="Live sessions"
						value={String(detail.inspection.livePhaseSessions.length)}
					/>
				</InfoCard>
				{openQuestions.length > 0 && (
					<InfoCard title="Open questions">
						<ul className="space-y-2">
							{openQuestions.map((q, i) => (
								<li key={i} className="text-sm text-muted-foreground">
									{q}
								</li>
							))}
						</ul>
					</InfoCard>
				)}
				{detail.diagnostics.missingArtifacts.length > 0 && (
					<InfoCard title="Missing artifacts">
						<ul className="space-y-1">
							{detail.diagnostics.missingArtifacts.map((a) => (
								<li key={a} className="text-sm text-muted-foreground">
									{a}
								</li>
							))}
						</ul>
					</InfoCard>
				)}
				{detail.diagnostics.warnings.length > 0 && (
					<InfoCard title="Warnings">
						<ul className="space-y-1">
							{detail.diagnostics.warnings.map((w, i) => (
								<li key={i} className="text-sm text-amber-600 dark:text-amber-400">
									{w}
								</li>
							))}
						</ul>
					</InfoCard>
				)}
			</div>
		);
	}

	if (section === "tasks") {
		const diagTasks = detail.diagnostics.tasks ?? [];
		const graph = detail.graph;
		const workDone = statusIndex(detail.item.status) >= statusIndex("pr-open");

		if (!graph && diagTasks.length === 0) {
			return (
				<div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
					No repo tasks — work has not been materialized yet.
				</div>
			);
		}

		if (graph) {
			return (
				<FeatureFirstTaskList
					graph={graph}
					diagTasks={diagTasks}
					workDone={workDone}
				/>
			);
		}

		// Fallback: flat diagnostic list when graph is unavailable
		const ORDER: Record<string, number> = { running: 0, paused: 1, blocked: 2, failed: 3, done: 4, ready: 5, planned: 6, created: 7 };
		const sorted = [...diagTasks].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
		return (
			<div className="space-y-2">
				{sorted.map((task) => (
					<TaskRow key={`${task.repoId}:${task.taskId}`} taskId={task.taskId} repoId={task.repoId} diag={task} workDone={workDone} />
				))}
			</div>
		);
	}

	if (section === "artifacts") {
		return <ArtifactsSection artifacts={detail.inspection.artifacts} onOpenArtifact={onOpenArtifact} />;
	}

	if (section === "validation") {
		const { gate1, gate2 } = detail.status;
		const validatorResults = detail.status.validatorResults ?? [];
		return (
			<div className="space-y-6">
				{/* Gates */}
				<div className="grid gap-4 md:grid-cols-2">
					<GateCard title="Gate 1 — Plan review" gate={gate1} />
					<GateCard title="Gate 2 — Implementation review" gate={gate2} />
				</div>

				{/* Per-repo assertion checklists */}
				{validatorResults.length === 0 ? (
					<InfoCard title="Validation">
						<div className="text-sm text-muted-foreground">No validator results yet.</div>
					</InfoCard>
				) : (
					validatorResults.map((result) => {
						const assertions = result.assertions ?? [];
						return (
							<InfoCard key={result.repoId} title={`${result.repoId} — ${result.status}`}>
								{assertions.length === 0 ? (
									<div className="text-sm text-muted-foreground">No assertions recorded.</div>
								) : (
									<div className="space-y-2">
										{assertions.map((a) => (
											<AssertionRow key={a.id} assertion={a} />
										))}
									</div>
								)}
							</InfoCard>
						);
					})
				)}
			</div>
		);
	}

	if (section === "sessions") {
		return <SessionsSection detail={detail} />;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Feature-first task list
// ---------------------------------------------------------------------------

type TaskDiag = DevtaskWorkDetail["diagnostics"]["tasks"][number];

const TASK_STATUS_STYLES: Record<string, { dot: string; text: string }> = {
	running: { dot: "bg-blue-500 animate-pulse", text: "text-blue-600 dark:text-blue-400" },
	paused:  { dot: "bg-amber-400", text: "text-amber-600 dark:text-amber-400" },
	blocked: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
	failed:  { dot: "bg-red-600", text: "text-red-700 dark:text-red-400" },
	done:    { dot: "bg-green-500", text: "text-green-600 dark:text-green-400" },
	ready:   { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
	planned: { dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
	created: { dot: "bg-muted-foreground/20", text: "text-muted-foreground" },
};

function FeatureFirstTaskList({
	graph,
	diagTasks,
	workDone,
}: {
	graph: DevtaskWorkGraph;
	diagTasks: TaskDiag[];
	workDone: boolean;
}) {
	const diagByTaskId = new Map(diagTasks.map((t) => [t.taskId, t]));
	const graphTaskById = new Map(graph.tasks.map((t) => [t.id, t]));
	const groupedTaskIds = new Set(graph.features.flatMap((f) => f.taskIds));
	const ungrouped = graph.tasks.filter((t) => !groupedTaskIds.has(t.id));

	return (
		<div className="space-y-6">
			{graph.features.map((feature) => {
				const featureTasks = feature.taskIds
					.map((id) => graphTaskById.get(id))
					.filter((t): t is DevtaskWorkGraphTask => Boolean(t));
				if (featureTasks.length === 0) return null;
				return (
					<div key={feature.id}>
						<FeatureHeading feature={feature} />
						<div className="space-y-2">
							{featureTasks.map((graphTask) => (
								<TaskRow
									key={graphTask.id}
									taskId={graphTask.id}
									repoId={graphTask.repoId}
									goal={graphTask.goal}
									diag={diagByTaskId.get(graphTask.id)}
									workDone={workDone}
								/>
							))}
						</div>
					</div>
				);
			})}
			{ungrouped.length > 0 && (
				<div>
					<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">
						Other tasks
					</div>
					<div className="space-y-2">
						{ungrouped.map((graphTask) => (
							<TaskRow
								key={graphTask.id}
								taskId={graphTask.id}
								repoId={graphTask.repoId}
								goal={graphTask.goal}
								diag={diagByTaskId.get(graphTask.id)}
								workDone={workDone}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function FeatureHeading({ feature }: { feature: DevtaskWorkGraphFeature }) {
	return (
		<div className="mb-2 flex items-center gap-3">
			<div className="h-px flex-1 bg-border/40" />
			<span className="shrink-0 text-xs font-semibold text-foreground/60">
				{feature.title}
			</span>
			<div className="h-px flex-1 bg-border/40" />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

function TaskRow({
	taskId,
	repoId,
	goal,
	diag,
	workDone = false,
}: {
	taskId: string;
	repoId: string;
	goal?: string;
	diag?: TaskDiag;
	workDone?: boolean;
}) {
	const status = diag?.status ?? "created";
	const style = TASK_STATUS_STYLES[status] ?? { dot: "bg-muted-foreground/20", text: "text-muted-foreground" };
	const isTerminal = status === "done";
	const isBlocked = status === "blocked" || status === "failed" || status === "paused";
	// Suppress stale blocking reasons once the work has a PR open or is completed
	const showReason = isBlocked && !workDone && diag?.reason;
	const showResult = isTerminal && diag?.resultSummary;

	return (
		<div className="rounded-lg border border-border/60 bg-background px-4 py-3">
			<div className="flex items-start gap-3">
				<span className={cn("mt-1.5 size-2 shrink-0 rounded-full", style.dot)} />
				<div className="min-w-0 flex-1">
					{/* Goal as primary text */}
					{goal && (
						<div className="text-sm text-foreground leading-snug">{goal}</div>
					)}
					{/* Repo + task ID as secondary identity */}
					<div className={cn("flex items-baseline gap-2 text-[11px]", goal ? "mt-1" : "")}>
						<span className="font-mono text-muted-foreground">{repoId}</span>
						<span className="text-muted-foreground/40">·</span>
						<span className="font-mono text-muted-foreground/60">{taskId}</span>
					</div>
					{/* Status row */}
					<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
						<span className={cn("font-medium capitalize", style.text)}>{status}</span>
						{diag && diag.failCount > 0 && (
							<span className="text-muted-foreground/60">
								{diag.failCount}/{diag.maxRetries} retries
							</span>
						)}
						{diag?.branch && (
							<span className="font-mono text-muted-foreground/50">{diag.branch}</span>
						)}
					</div>
				</div>
				{diag?.prUrl && (
					<a
						href={diag.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="shrink-0 flex items-center gap-1 rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
					>
						<ExternalLink className="size-2.5" />
						PR
					</a>
				)}
			</div>

			{/* Blocking reason */}
			{showReason && (
				<div className="mt-2 rounded bg-red-500/5 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400 border border-red-500/10">
					{diag?.reason}
				</div>
			)}

			{/* Result summary */}
			{showResult && (
				<div className="mt-2 text-[11px] text-muted-foreground italic">
					{diag?.resultSummary}
				</div>
			)}

			{/* Waiting on — non-terminal, non-blocked states */}
			{!isTerminal && !isBlocked && diag && diag.waitingOn !== "complete" && (
				<div className="mt-1.5 text-[11px] text-muted-foreground">
					Waiting on: <span className="text-foreground/70">{diag.waitingOn}</span>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Validation components
// ---------------------------------------------------------------------------

type GateState = DevtaskWorkDetail["status"]["gate1"];
type Assertion = DevtaskWorkDetail["status"]["validatorResults"][number]["assertions"][number];

function GateCard({ title, gate }: { title: string; gate: GateState }) {
	const statusColor =
		gate?.status === "approved"
			? "text-green-600 dark:text-green-400"
			: gate?.status === "rejected"
				? "text-destructive"
				: "text-muted-foreground";

	return (
		<InfoCard title={title}>
			{!gate ? (
				<div className="text-sm text-muted-foreground">Not yet reviewed.</div>
			) : (
				<>
					<div className={cn("text-sm font-medium capitalize", statusColor)}>
						{gate.status}
					</div>
					{gate.message && (
						<p className="mt-1.5 text-xs text-muted-foreground whitespace-pre-wrap">
							{gate.message}
						</p>
					)}
					<div className="mt-1.5 text-[11px] text-muted-foreground/60">
						{formatRelativeTime(gate.updatedAt)}
					</div>
				</>
			)}
		</InfoCard>
	);
}

const ASSERTION_STATUS_STYLES = {
	passed:  { icon: "✓", cls: "text-green-600 dark:text-green-400" },
	failed:  { icon: "✗", cls: "text-destructive" },
	skipped: { icon: "–", cls: "text-muted-foreground" },
};

function AssertionRow({ assertion }: { assertion: Assertion }) {
	const style = ASSERTION_STATUS_STYLES[assertion.status];
	const isProblematic = assertion.status === "failed" || assertion.status === "skipped";

	return (
		<div className={cn(
			"rounded-md border px-3 py-2",
			assertion.status === "failed"
				? "border-red-200/60 bg-red-50/30 dark:border-red-900/40 dark:bg-red-950/10"
				: assertion.status === "skipped"
					? "border-border/40 bg-muted/20"
					: "border-border/40 bg-background",
		)}>
			<div className="flex items-start gap-2">
				<span className={cn("shrink-0 mt-px text-xs font-bold w-3 text-center", style.cls)}>
					{style.icon}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="font-mono text-[11px] text-muted-foreground/60 shrink-0">
							{assertion.id}
						</span>
						<span className={cn("text-xs font-medium capitalize", style.cls)}>
							{assertion.status}
						</span>
						{assertion.attribution && isProblematic && (
							<span className="text-[10px] text-muted-foreground/60 italic">
								{assertion.attribution}
							</span>
						)}
					</div>
					{assertion.evidence && (
						<p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
							{assertion.evidence}
						</p>
					)}
					{assertion.attributionReason && isProblematic && (
						<p className="mt-1 text-[11px] text-muted-foreground/70 italic">
							{assertion.attributionReason}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sessions section — phase-run based with transcript viewer
// ---------------------------------------------------------------------------

type PhaseRun = DevtaskWorkDetail["inspection"]["latestPhaseRuns"][number];

const PHASE_LABELS: Record<string, string> = {
	orchestrate: "Orchestrate",
	"repo-plan": "Repo planning",
	execute: "Execute",
	review: "Review",
};

const PHASE_DISPLAY_ORDER = ["orchestrate", "repo-plan", "execute", "review"];

function phaseRunKey(run: PhaseRun): string {
	return `${run.phase}:${run.repoId ?? ""}:${run.taskId ?? ""}`;
}

function groupPhaseRuns(runs: PhaseRun[]): Array<{ phase: string; runs: PhaseRun[] }> {
	const grouped = new Map<string, PhaseRun[]>();
	for (const run of runs) {
		const group = grouped.get(run.phase) ?? [];
		group.push(run);
		grouped.set(run.phase, group);
	}
	const ordered = PHASE_DISPLAY_ORDER.filter((p) => grouped.has(p));
	const others = [...grouped.keys()].filter((p) => !PHASE_DISPLAY_ORDER.includes(p));
	return [...ordered, ...others].map((p) => ({ phase: p, runs: grouped.get(p)! }));
}


function SessionsSection({ detail }: { detail: DevtaskWorkDetail }) {
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const orchestratorRunning = detail.status.orchestratorSession.running;
	const phaseRuns = detail.inspection.latestPhaseRuns;
	const groups = useMemo(() => groupPhaseRuns(phaseRuns), [phaseRuns]);

	const selectedRun = phaseRuns.find((r) => phaseRunKey(r) === selectedKey) ?? null;
	const selectedDisplayStatus = selectedRun
		? normalizeRunStatus(selectedRun.status, orchestratorRunning)
		: null;
	const isActiveRun = selectedDisplayStatus === "running";

	const transcriptFile = selectedRun?.transcriptPath ?? selectedRun?.outputPath ?? null;
	const transcriptQuery = useQuery({
		queryKey: ["devtask", "phase-transcript", transcriptFile],
		queryFn: () => loadDevtaskFileContent(transcriptFile!),
		enabled: Boolean(transcriptFile),
		staleTime: 10_000,
		refetchInterval: isActiveRun ? 5_000 : false,
	});

	return (
		<div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
			{/* Left: phase run list grouped by phase */}
			<div className="space-y-4">
				{groups.length === 0 ? (
					<InfoCard title="Sessions">
						<div className="text-sm text-muted-foreground">
							No sessions recorded yet.
						</div>
					</InfoCard>
				) : (
					groups.map(({ phase, runs }) => (
						<InfoCard key={phase} title={PHASE_LABELS[phase] ?? phase}>
							<div className="space-y-1.5">
								{runs.map((run) => {
									const key = phaseRunKey(run);
									const rs = normalizeRunStatus(run.status, orchestratorRunning);
									const live = rs === "running";
									return (
										<button
											key={key}
											type="button"
											onClick={() => setSelectedKey(key)}
											className={cn(
												"flex w-full items-start justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
												key === selectedKey
													? "border-foreground/20 bg-accent"
													: "border-border/60 bg-background hover:bg-accent/60",
											)}
										>
											<div className="min-w-0">
												<div className="flex items-center gap-1.5">
													{live && (
														<Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />
													)}
													<span className="truncate text-xs font-medium">
														{run.taskId
															? `${run.repoId} / ${run.taskId}`
															: (run.repoId ?? run.phase)}
													</span>
												</div>
												<div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
													<span
														className={cn(
															"capitalize font-medium",
															live
																? "text-blue-500"
																: rs === "done"
																	? "text-green-600 dark:text-green-400"
																	: rs === "failed"
																		? "text-destructive"
																		: "",
														)}
													>
														{rs}
													</span>
													{run.provider && (
														<span className="opacity-50">{run.provider}</span>
													)}
												</div>
											</div>
											{(run.transcriptPath || run.outputPath) && (
												<FileText className="ml-2 mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
											)}
										</button>
									);
								})}
							</div>
						</InfoCard>
					))
				)}
			</div>

			{/* Right: transcript viewer */}
			<InfoCard title={selectedRun ? "Transcript" : "Session output"}>
				{!selectedRun ? (
					<div className="text-sm text-muted-foreground">
						Select a session to view its transcript.
					</div>
				) : !transcriptFile ? (
					<div className="text-sm text-muted-foreground">
						No transcript path recorded for this session.
					</div>
				) : transcriptQuery.isPending ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> Loading transcript…
					</div>
				) : transcriptQuery.data?.type === "file" ? (
					<TranscriptViewer
						content={transcriptQuery.data.content}
						provider={selectedRun.provider}
					/>
				) : (
					<div className="text-sm text-muted-foreground">
						No transcript content found.
					</div>
				)}
			</InfoCard>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Artifacts section — owns selection + inline content loading
// ---------------------------------------------------------------------------

function ArtifactsSection({
	artifacts,
	onOpenArtifact,
}: {
	artifacts: DevtaskWorkDetail["inspection"]["artifacts"];
	onOpenArtifact?: (path: string) => void;
}) {
	// artifactPath = selected top-level artifact; subPath = selected file inside a directory artifact
	const [artifactPath, setArtifactPath] = useState<string | null>(null);
	const [subPath, setSubPath] = useState<string | null>(null);
	const selectedArtifact = artifacts.find((a) => a.path === artifactPath) ?? null;

	// When artifact changes, clear sub-selection
	const selectArtifact = (path: string) => {
		setArtifactPath(path);
		setSubPath(null);
	};

	// Load the artifact itself (file or directory listing)
	const artifactQuery = useQuery({
		queryKey: ["devtask", "file-content", artifactPath],
		queryFn: () => loadDevtaskFileContent(artifactPath!),
		enabled: Boolean(artifactPath) && Boolean(selectedArtifact?.exists),
		staleTime: 30_000,
	});

	// Load a sub-file when drilling into a directory
	const subQuery = useQuery({
		queryKey: ["devtask", "file-content", subPath],
		queryFn: () => loadDevtaskFileContent(subPath!),
		enabled: Boolean(subPath),
		staleTime: 30_000,
	});

	const viewPath = subPath ?? artifactPath;
	const viewTitle = subPath
		? subPath.split("/").at(-1) ?? subPath
		: selectedArtifact?.label ?? "Content";

	return (
		<div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
			{/* Left: artifact list */}
			<InfoCard title="Artifacts">
				{artifacts.length === 0 ? (
					<div className="text-sm text-muted-foreground">No artifacts yet.</div>
				) : (
					<div className="space-y-1.5">
						{artifacts.map((artifact) => (
							<button
								key={artifact.label}
								type="button"
								onClick={() => artifact.exists && selectArtifact(artifact.path)}
								className={cn(
									"w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
									artifactPath === artifact.path
										? "border-foreground/20 bg-accent"
										: artifact.exists
											? "border-border/60 bg-background hover:bg-accent/50 cursor-pointer"
											: "border-border/40 bg-background opacity-50 cursor-default",
								)}
							>
								<div className="flex items-center justify-between gap-3">
									<span className="font-medium">{artifact.label}</span>
									<span className={cn(
										"text-[11px]",
										artifact.exists ? "text-muted-foreground" : "text-muted-foreground/50",
									)}>
										{artifact.exists ? "present" : "missing"}
									</span>
								</div>
							</button>
						))}
					</div>
				)}
			</InfoCard>

			{/* Right: content viewer */}
			<InfoCard title={viewTitle}>
				{!selectedArtifact ? (
					<div className="text-sm text-muted-foreground">Select an artifact to view its content.</div>
				) : !selectedArtifact.exists ? (
					<div className="text-sm text-muted-foreground">This artifact is missing on disk.</div>
				) : artifactQuery.isPending ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> Loading…
					</div>
				) : artifactQuery.data?.type === "directory" ? (
					// Directory: show file listing, with sub-file content if one is selected
					<DirectoryViewer
						entries={artifactQuery.data.entries}
						subPath={subPath}
						subQuery={subQuery}
						onSelectEntry={(p) => setSubPath(p)}
						onOpenArtifact={onOpenArtifact}
					/>
				) : artifactQuery.data?.type === "file" ? (
					<FileViewer
						content={artifactQuery.data.content}
						path={viewPath!}
						onOpenArtifact={onOpenArtifact}
					/>
				) : (
					<div className="text-sm text-muted-foreground">Failed to load content.</div>
				)}
			</InfoCard>
		</div>
	);
}

function DirectoryViewer({
	entries,
	subPath,
	subQuery,
	onSelectEntry,
	onOpenArtifact,
}: {
	entries: DevtaskFileEntry[];
	subPath: string | null;
	subQuery: ReturnType<typeof useQuery>;
	onSelectEntry: (path: string | null) => void;
	onOpenArtifact?: (path: string) => void;
}) {
	const files = entries.filter((e) => !e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
	const dirs = entries.filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
	const sorted = [...dirs, ...files];

	if (sorted.length === 0) {
		return <div className="text-sm text-muted-foreground">Directory is empty.</div>;
	}

	if (!subPath) {
		return (
			<div className="space-y-1">
				{sorted.map((entry) => (
					<button
						key={entry.path}
						type="button"
						onClick={() => !entry.isDirectory && onSelectEntry(entry.path)}
						className={cn(
							"flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
							entry.isDirectory
								? "cursor-default text-muted-foreground/60"
								: "hover:bg-accent/50 cursor-pointer text-foreground",
						)}
					>
						<span className="text-[11px] text-muted-foreground/40 w-3">
							{entry.isDirectory ? "▸" : ""}
						</span>
						<span className="font-mono text-xs">{entry.name}</span>
					</button>
				))}
			</div>
		);
	}

	const subData = subQuery.data as { type: "file"; content: string } | undefined;
	return (
		<div>
			<button
				type="button"
				onClick={() => onSelectEntry(null)}
				className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
			>
				← Back to listing
			</button>
			{subQuery.isPending ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" /> Loading…
				</div>
			) : subData?.content != null ? (
				<FileViewer content={subData.content} path={subPath} onOpenArtifact={onOpenArtifact} />
			) : (
				<div className="text-sm text-muted-foreground">Failed to load file.</div>
			)}
		</div>
	);
}

function FileViewer({
	content,
	path,
	onOpenArtifact,
}: {
	content: string;
	path: string;
	onOpenArtifact?: (path: string) => void;
}) {
	return (
		<div className="relative">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={() => onOpenArtifact?.(path)}
				className="absolute right-0 top-0 h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
			>
				<ExternalLink className="size-3" />
				Open externally
			</Button>
			<pre className="mt-6 max-h-[60vh] overflow-auto rounded-md border border-border/40 bg-muted/30 p-3 text-[11px] leading-relaxed text-foreground font-mono whitespace-pre-wrap break-words">
				{content}
			</pre>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function SectionButton({
	active,
	icon: Icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof FileText;
	label: string;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			onClick={onClick}
			className={cn(
				"h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground",
				active ? "bg-accent text-foreground" : undefined,
			)}
		>
			<Icon className="mr-1.5 size-3" />
			{label}
		</Button>
	);
}


function InfoCard({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-lg border border-border/60 bg-background p-4">
			<div className="mb-3 text-sm font-medium text-foreground">{title}</div>
			{children}
		</section>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-3 py-1.5 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="text-right text-foreground">{value}</span>
		</div>
	);
}
