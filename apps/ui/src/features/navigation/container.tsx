import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import type { WorkspaceGroup, WorkspaceRow, WorkspaceStatus } from "@/lib/api";
import { devtaskWorkListQueryOptions } from "@/lib/devtask-query-client";
import { WorkspacesSidebar } from "./index";

type WorkspaceToastVariant = "default" | "destructive";

type WorkspacesSidebarContainerProps = {
	selectedWorkspaceId: string | null;
	autoSelectEnabled?: boolean;
	busyWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	newWorkspaceShortcut?: string | null;
	addRepositoryShortcut?: string | null;
	sidebarFilterShortcut?: string | null;
	onSelectWork: (workId: string | null, workspaceId: string | null) => void;
	onOpenNewWorkspace?: () => void;
	onAddRepositoryNeedsStart?: (repositoryId: string) => void;
	onMoveLocalToWorktree?: (workspaceId: string) => void;
	pushWorkspaceToast: (
		description: string,
		title?: string,
		variant?: WorkspaceToastVariant,
		opts?: {
			action?: { label: string; onClick: () => void; destructive?: boolean };
			persistent?: boolean;
		},
	) => void;
};

export const WorkspacesSidebarContainer = memo(
	function WorkspacesSidebarContainer({
		selectedWorkspaceId,
		autoSelectEnabled: _autoSelectEnabled = true,
		busyWorkspaceIds,
		interactionRequiredWorkspaceIds,
		newWorkspaceShortcut,
		addRepositoryShortcut,
		sidebarFilterShortcut,
		onSelectWork,
		onOpenNewWorkspace: _onOpenNewWorkspace,
		onAddRepositoryNeedsStart: _onAddRepositoryNeedsStart,
		onMoveLocalToWorktree,
		pushWorkspaceToast: _pushWorkspaceToast,
	}: WorkspacesSidebarContainerProps) {
		const { data } = useQuery(devtaskWorkListQueryOptions());
		const groups = projectWorkGroups(data?.work ?? []);
		const workspaceId = data?.workspaceId ?? null;
		const archivedRows: WorkspaceRow[] = [];

		return (
			<WorkspacesSidebar
				groups={groups}
				archivedRows={archivedRows}
				sidebarGrouping="status"
				sidebarRepoFilterIds={[]}
				sidebarSort="custom"
				addingRepository={false}
				archivingWorkspaceIds={new Set()}
				selectedWorkspaceId={selectedWorkspaceId}
				busyWorkspaceIds={busyWorkspaceIds}
				interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
				newWorkspaceShortcut={newWorkspaceShortcut}
				addRepositoryShortcut={addRepositoryShortcut}
				sidebarFilterShortcut={sidebarFilterShortcut}
				onSelectWorkspace={(workId) => onSelectWork(workId, workspaceId)}
				onMoveLocalToWorktree={onMoveLocalToWorktree}
				disableRowHoverCards
			/>
		);
	},
);

function projectWorkGroups(
	work: Array<{
		id: string;
		title: string;
		status: string;
		updatedAt: string;
		nextAction: string;
		waitingOn: string;
		sourceType: string;
	}>,
): WorkspaceGroup[] {
	const grouped = new Map<string, WorkspaceRow[]>();

	for (const item of work) {
		const groupId = normalizeWorkGroup(item.status);
		const rows = grouped.get(groupId) ?? [];
		rows.push({
			id: item.id,
			title: item.title,
			status: mapWorkStatus(item.status),
			state: "ready",
			directoryName: item.sourceType,
			branch: item.nextAction,
			repoName: item.waitingOn,
			updatedAt: item.updatedAt,
		});
		grouped.set(groupId, rows);
	}

	return Array.from(grouped.entries()).map(([groupId, rows]) => ({
		id: groupId,
		label: groupLabel(groupId),
		tone: groupTone(groupId),
		rows: rows.sort((left, right) =>
			(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
		),
	}));
}

function normalizeWorkGroup(status: string): string {
	if (status.includes("failed") || status.includes("blocked")) return "review";
	if (status.includes("done") || status.includes("passed")) return "done";
	if (status.includes("running") || status.includes("execut")) return "progress";
	return "backlog";
}

function mapWorkStatus(status: string): WorkspaceStatus {
	if (status.includes("done") || status.includes("passed")) return "done";
	if (status.includes("failed") || status.includes("blocked")) return "review";
	if (status.includes("running") || status.includes("execut")) {
		return "in-progress";
	}
	return "backlog";
}

function groupLabel(groupId: string): string {
	switch (groupId) {
		case "progress":
			return "In Progress";
		case "review":
			return "Attention";
		case "done":
			return "Done";
		default:
			return "Planned";
	}
}

function groupTone(groupId: string): WorkspaceGroup["tone"] {
	switch (groupId) {
		case "progress":
			return "progress";
		case "review":
			return "review";
		case "done":
			return "done";
		default:
			return "backlog";
	}
}
