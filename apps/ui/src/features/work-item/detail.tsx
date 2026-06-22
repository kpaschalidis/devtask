import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileText, ListChecks, MessagesSquare } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActiveThreadViewport, type PresentedSessionPane } from "@/features/panel/thread-viewport";
import type { ThreadMessageLike } from "@/lib/api";
import {
	devtaskSessionDetailQueryOptions,
	devtaskWorkDetailQueryOptions,
} from "@/lib/devtask-query-client";
import { cn } from "@/lib/utils";

type WorkItemDetailProps = {
	workId: string | null;
	selectedSessionThreadId?: string | null;
	selectedArtifactId?: string | null;
	onSelectSession?: (threadId: string) => void;
	onOpenArtifact?: (path: string) => void;
	headerLeading?: React.ReactNode;
	headerActions?: React.ReactNode;
};

type SectionId = "overview" | "artifacts" | "sessions" | "validation";

export const WorkItemDetail = memo(function WorkItemDetail({
	workId,
	selectedSessionThreadId = null,
	selectedArtifactId = null,
	onSelectSession,
	onOpenArtifact,
	headerLeading,
	headerActions,
}: WorkItemDetailProps) {
	const detailQuery = useQuery({
		...devtaskWorkDetailQueryOptions(workId ?? "__none__"),
		enabled: Boolean(workId),
	});
	const sessionQuery = useQuery({
		...devtaskSessionDetailQueryOptions(selectedSessionThreadId ?? "__none__"),
		enabled: Boolean(selectedSessionThreadId),
	});

	const detail = detailQuery.data ?? null;
	const routeSection: SectionId = selectedSessionThreadId
		? "sessions"
		: selectedArtifactId
			? "artifacts"
			: "overview";
	const [manualSection, setManualSection] = useState<SectionId | null>(null);
	const activeSection = manualSection ?? routeSection;
	const selectedArtifact = useMemo(
		() =>
			detail?.inspection.artifacts.find(
				(artifact) => artifact.label === selectedArtifactId,
			) ?? null,
		[detail?.inspection.artifacts, selectedArtifactId],
	);
	const sessionPane = useMemo<PresentedSessionPane | null>(() => {
		if (!selectedSessionThreadId || !sessionQuery.data) {
			return null;
		}
		return {
			sessionId: selectedSessionThreadId,
			sending: false,
			hasLoaded: true,
			presentationState: "presented",
			messages: sessionQuery.data.transcript.map(toThreadMessage),
		};
	}, [selectedSessionThreadId, sessionQuery.data]);

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
				Loading work item...
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
			<div className="border-b border-border/60 px-4 py-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						{headerLeading}
						<div className="min-w-0">
							<div className="truncate text-sm font-medium text-foreground">
								{detail.item.source.title}
							</div>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span>{detail.item.id}</span>
								<span>{detail.item.status}</span>
								<span>{detail.item.source.type}</span>
							</div>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{headerActions}
					</div>
				</div>
				<div className="mt-3 flex flex-wrap gap-2">
					<SectionButton
						active={activeSection === "overview"}
						icon={FileText}
						label="Overview"
						onClick={() => setManualSection("overview")}
					/>
					<SectionButton
						active={activeSection === "artifacts"}
						icon={ListChecks}
						label="Artifacts"
						onClick={() => setManualSection("artifacts")}
					/>
					<SectionButton
						active={activeSection === "sessions"}
						icon={MessagesSquare}
						label="Sessions"
						onClick={() => setManualSection("sessions")}
					/>
					<SectionButton
						active={activeSection === "validation"}
						icon={CheckCircle2}
						label="Validation"
						onClick={() => setManualSection("validation")}
					/>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto px-4 py-4">
				{activeSection === "overview" ? (
					<div className="grid gap-4 md:grid-cols-2">
						<InfoCard title="Status">
							<Row label="State" value={detail.item.status} />
							<Row label="Waiting on" value={detail.diagnostics.waitingOn} />
							<Row label="Next" value={detail.diagnostics.next} />
							<Row label="Updated" value={formatTimestamp(detail.item.updatedAt)} />
						</InfoCard>
						<InfoCard title="Orchestration">
							<Row
								label="Orchestrator"
								value={
									detail.status.orchestratorSession.running ? "running" : "idle"
								}
							/>
							<Row label="Gate 1" value={detail.status.gate1?.status ?? "not set"} />
							<Row label="Gate 2" value={detail.status.gate2?.status ?? "not set"} />
							<Row
								label="Live sessions"
								value={String(detail.inspection.livePhaseSessions.length)}
							/>
						</InfoCard>
					</div>
				) : null}

				{activeSection === "artifacts" ? (
					<div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
						<InfoCard title="Artifacts">
							<div className="space-y-2">
								{detail.inspection.artifacts.map((artifact) => (
									<div
										key={artifact.label}
										className={cn(
											"rounded-md border px-3 py-2 text-sm",
											selectedArtifact?.label === artifact.label
												? "border-foreground/20 bg-accent"
												: "border-border/60 bg-background",
										)}
									>
										<div className="flex items-center justify-between gap-3">
											<span className="font-medium">{artifact.label}</span>
											<span className="text-xs text-muted-foreground">
												{artifact.exists ? "present" : "missing"}
											</span>
										</div>
										<div className="mt-1 break-all text-xs text-muted-foreground">
											{artifact.path}
										</div>
										{artifact.exists ? (
											<div className="mt-2">
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => onOpenArtifact?.(artifact.path)}
												>
													Open in editor
												</Button>
											</div>
										) : null}
									</div>
								))}
							</div>
						</InfoCard>
						<InfoCard title={selectedArtifact?.label ?? "Artifact detail"}>
							{selectedArtifact ? (
								<>
									<Row label="Path" value={selectedArtifact.path} />
									<Row
										label="Exists"
										value={selectedArtifact.exists ? "yes" : "no"}
									/>
								</>
							) : (
								<div className="text-sm text-muted-foreground">
									Select an artifact route to inspect it.
								</div>
							)}
						</InfoCard>
					</div>
				) : null}

				{activeSection === "sessions" ? (
					<div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
						<InfoCard title="Linked sessions">
							<div className="space-y-2">
								{detail.sessions.length === 0 ? (
									<div className="text-sm text-muted-foreground">
										No linked sessions yet.
									</div>
								) : (
									detail.sessions.map((session) => (
										<button
											key={session.threadId}
											type="button"
											onClick={() => onSelectSession?.(session.threadId)}
											className={cn(
												"flex w-full items-start justify-between rounded-md border px-3 py-2 text-left text-sm",
												session.threadId === selectedSessionThreadId
													? "border-foreground/20 bg-accent"
													: "border-border/60 bg-background hover:bg-accent/60",
											)}
										>
											<div className="min-w-0">
												<div className="truncate font-medium">
													{session.agentName}
												</div>
												<div className="mt-1 text-xs text-muted-foreground">
													{session.status} · {formatTimestamp(session.startedAt)}
												</div>
											</div>
											<span className="ml-3 shrink-0 text-xs text-muted-foreground">
												{session.labels.join(", ") || "session"}
											</span>
										</button>
									))
								)}
							</div>
						</InfoCard>
						<InfoCard title="Session output">
							{selectedSessionThreadId ? (
								sessionQuery.isPending ? (
									<div className="text-sm text-muted-foreground">
										Loading session...
									</div>
								) : sessionPane ? (
									<div className="min-h-[520px] overflow-hidden rounded-md border border-border/60 bg-background">
										<ActiveThreadViewport
											hasSession
											workspaceName={detail.item.source.title}
											pane={sessionPane}
										/>
									</div>
								) : (
									<div className="text-sm text-muted-foreground">
										No transcript available for this session.
									</div>
								)
							) : (
								<div className="text-sm text-muted-foreground">
									Select a session to inspect its timeline and events.
								</div>
							)}
						</InfoCard>
					</div>
				) : null}

				{activeSection === "validation" ? (
					<div className="grid gap-4 md:grid-cols-2">
						<InfoCard title="Validator results">
							<div className="space-y-2">
								{detail.status.validatorResults.length === 0 ? (
									<div className="text-sm text-muted-foreground">
										No validator results yet.
									</div>
								) : (
									detail.status.validatorResults.map((result) => (
										<div
											key={result.repoId}
											className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
										>
											<div className="flex items-center justify-between gap-3">
												<span className="font-medium">{result.repoId}</span>
												<span className="text-xs text-muted-foreground">
													{result.status}
												</span>
											</div>
											<div className="mt-1 text-xs text-muted-foreground">
												{result.failedAssertions}/{result.totalAssertions} failed
											</div>
										</div>
									))
								)}
							</div>
						</InfoCard>
						<InfoCard title="Problem tasks">
							<div className="space-y-2">
								{detail.inspection.problemTasks.length === 0 ? (
									<div className="text-sm text-muted-foreground">
										No blocked or failed tasks.
									</div>
								) : (
									detail.inspection.problemTasks.map((task) => (
										<div
											key={`${task.repoId}:${task.taskId}`}
											className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
										>
											<div className="flex items-center justify-between gap-3">
												<span className="font-medium">
													{task.repoId} / {task.taskId}
												</span>
												<span className="text-xs text-muted-foreground">
													{task.status}
												</span>
											</div>
											<div className="mt-1 text-xs text-muted-foreground">
												{task.reason ?? "No reason recorded"}
											</div>
										</div>
									))
								)}
							</div>
						</InfoCard>
					</div>
				) : null}
			</div>
		</div>
	);
});

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
				"h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground",
				active ? "bg-accent text-foreground" : undefined,
			)}
		>
			<Icon className="mr-1.5 size-3.5" />
			{label}
		</Button>
	);
}

function toThreadMessage(message: {
	id: string;
	role: "agent" | "user";
	content: string;
	createdAt: string;
}): ThreadMessageLike {
	return {
		id: message.id,
		role: message.role === "agent" ? "assistant" : "user",
		createdAt: message.createdAt,
		content: [
			{
				type: "text",
				id: `${message.id}:text:0`,
				text: message.content,
			},
		],
	};
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

function formatTimestamp(value: string | null): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}
