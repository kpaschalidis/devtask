// Work-first navigation sidebar for devtask.
// VIEWS: All work, Active, Needs you, Shipped — with counts.
// PROJECTS: one row per workspace (project = workspace in the backend).
// Subitems (repos within a workspace) are intentionally not shown yet.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { devtaskWorkListQueryOptions } from "@/lib/devtask-query-client";
import {
	computeViewCounts,
	NAV_VIEWS,
	type NavView,
} from "@/lib/devtask-projections";
import { cn } from "@/lib/utils";
import { router } from "@/router";
import {
	useRouterNavView,
	useRouterProject,
	useRouterSelectedWorkspaceId,
} from "@/router/use-router-selection";

type DevtaskNavSidebarContainerProps = {
	onSelectWork: (workId: string | null, workspaceId: string | null) => void;
};

export const DevtaskNavSidebarContainer = memo(
	function DevtaskNavSidebarContainer({
		onSelectWork,
	}: DevtaskNavSidebarContainerProps) {
		const { data } = useQuery(devtaskWorkListQueryOptions());
		const work = data?.work ?? [];
		const apiWorkspaceId = data?.workspaceId ?? null;
		const workspaceName = data?.workspaceName ?? apiWorkspaceId ?? null;
		const counts = computeViewCounts(work);

		// Initialize workspace in router when API returns a workspaceId and none
		// is selected yet. Single-workspace boot path for devtask.
		const routerWorkspaceId = useRouterSelectedWorkspaceId();
		const initRef = useRef(false);
		useEffect(() => {
			if (initRef.current || !apiWorkspaceId || routerWorkspaceId) return;
			initRef.current = true;
			onSelectWork(null, apiWorkspaceId);
		}, [apiWorkspaceId, routerWorkspaceId, onSelectWork]);

		const workspaceId = routerWorkspaceId ?? apiWorkspaceId;
		const navView = useRouterNavView();
		const project = useRouterProject();

		function navigateToView(view: NavView | null) {
			if (!workspaceId) return;
			void router.navigate({
				to: "/w/$workspaceId",
				params: { workspaceId },
				search: { view: "conversation", navView: view ?? undefined },
				replace: true,
			});
		}

		function navigateToProject(projectId: string) {
			if (!workspaceId) return;
			void router.navigate({
				to: "/w/$workspaceId",
				params: { workspaceId },
				search: { view: "conversation", project: projectId },
				replace: true,
			});
		}

		const isAllWork = !navView && !project;

		return (
			<DevtaskNavSidebar
				workspaceId={apiWorkspaceId}
				workspaceName={workspaceName}
				workCount={counts.all}
				counts={counts}
				isAllWork={isAllWork}
				selectedNavView={navView as NavView | null}
				selectedProject={project}
				onSelectAllWork={() => navigateToView(null)}
				onSelectNavView={navigateToView}
				onSelectProject={navigateToProject}
			/>
		);
	},
);

type DevtaskNavSidebarProps = {
	workspaceId: string | null;
	workspaceName: string | null;
	workCount: number;
	counts: ReturnType<typeof computeViewCounts>;
	isAllWork: boolean;
	selectedNavView: NavView | null;
	selectedProject: string | null;
	onSelectAllWork: () => void;
	onSelectNavView: (view: NavView) => void;
	onSelectProject: (projectId: string) => void;
};

const DevtaskNavSidebar = memo(function DevtaskNavSidebar({
	workspaceId,
	workspaceName,
	workCount,
	counts,
	isAllWork,
	selectedNavView,
	selectedProject,
	onSelectAllWork,
	onSelectNavView,
	onSelectProject,
}: DevtaskNavSidebarProps) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<TrafficLightSpacer side="left" width={94} />

			<div className="min-h-0 flex-1 overflow-y-auto py-2">
				{/* VIEWS section */}
				<SectionLabel>Views</SectionLabel>
				<div className="px-2 pb-1">
					<NavItem
						label="All work"
						active={isAllWork}
						count={counts.all}
						onClick={onSelectAllWork}
					/>
					{NAV_VIEWS.map((view) => {
						const count =
							view.id === "active"
								? counts.active
								: view.id === "needs-you"
									? counts.needsYou
									: counts.shipped;
						return (
							<NavItem
								key={view.id}
								label={view.label}
								active={selectedNavView === view.id}
								count={count}
								onClick={() => onSelectNavView(view.id)}
							/>
						);
					})}
				</div>

				{/* PROJECTS section */}
				<div className="mt-3">
					<SectionLabel>Projects</SectionLabel>
					<div className="px-2">
						{!workspaceId ? (
							<div className="px-1 py-1 text-xs text-muted-foreground/50">
								No workspace
							</div>
						) : (
							<WorkspaceRow
								label={workspaceName ?? workspaceId}
								count={workCount}
								active={selectedProject === workspaceId}
								onClick={() => onSelectProject(workspaceId)}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="mb-0.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
			{children}
		</div>
	);
}

function NavItem({
	label,
	active,
	count,
	onClick,
}: {
	label: string;
	active: boolean;
	count: number;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
			)}
		>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count > 0 ? (
				<span className="ml-2 shrink-0 tabular-nums text-xs text-muted-foreground">
					{count}
				</span>
			) : null}
		</button>
	);
}

function WorkspaceRow({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
			)}
		>
			{/* Expand arrow — subitems not implemented yet */}
			<ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count > 0 ? (
				<span className="ml-1 shrink-0 tabular-nums text-xs text-muted-foreground">
					{count}
				</span>
			) : null}
		</button>
	);
}
