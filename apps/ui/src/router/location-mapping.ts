import type { AppSettings } from "@/lib/settings";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";
import type { WorkspaceSearch } from "./index";

export type SelectionLocationInput = {
	viewMode: ShellViewMode;
	workspaceId: string | null;
	workId?: string | null;
	sessionThreadId?: string | null;
	artifactId?: string | null;
	// Compatibility shim for the copied session-first shell. During migration,
	// legacy callers may still pass `sessionId`; we treat it as the primary work
	// id until the rest of the shell is converted.
	sessionId?: string | null;
};

export type PathSelection = {
	workspaceId: string | null;
	workId: string | null;
	sessionThreadId: string | null;
	artifactId: string | null;
	// Deprecated compatibility alias. Temporary until the shell stops reading
	// selectedSessionId as its primary selection.
	sessionId: string | null;
};

export type SelectionLocation =
	| { to: "/" }
	| { to: "/start" }
	| {
			to: "/w/$workspaceId";
			params: { workspaceId: string };
			search: WorkspaceSearch;
	  }
	| {
			to: "/w/$workspaceId/work/$workId";
			params: { workspaceId: string; workId: string };
			search: WorkspaceSearch;
	  }
	| {
			to: "/w/$workspaceId/work/$workId/session/$threadId";
			params: { workspaceId: string; workId: string; threadId: string };
			search: WorkspaceSearch;
	  }
	| {
			to: "/w/$workspaceId/work/$workId/artifact/$artifactId";
			params: { workspaceId: string; workId: string; artifactId: string };
			search: WorkspaceSearch;
	  };

function viewSearch(viewMode: ShellViewMode): WorkspaceSearch {
	return { view: viewMode === "editor" ? "editor" : "conversation" };
}

function normalizeSelectionInput(input: SelectionLocationInput): {
	viewMode: ShellViewMode;
	workspaceId: string | null;
	workId: string | null;
	sessionThreadId: string | null;
	artifactId: string | null;
} {
	const workId = input.workId ?? input.sessionId ?? null;
	return {
		viewMode: input.viewMode,
		workspaceId: input.workspaceId,
		workId,
		sessionThreadId: input.sessionThreadId ?? null,
		artifactId: input.artifactId ?? null,
	};
}

export function selectionToLocation(input: SelectionLocationInput): SelectionLocation {
	const { viewMode, workspaceId, workId, sessionThreadId, artifactId } =
		normalizeSelectionInput(input);
	if (viewMode === "start") return { to: "/start" };
	if (!workspaceId) return { to: "/" };
	if (workId && sessionThreadId) {
		return {
			to: "/w/$workspaceId/work/$workId/session/$threadId",
			params: { workspaceId, workId, threadId: sessionThreadId },
			search: viewSearch(viewMode),
		};
	}
	if (workId && artifactId) {
		return {
			to: "/w/$workspaceId/work/$workId/artifact/$artifactId",
			params: { workspaceId, workId, artifactId },
			search: viewSearch(viewMode),
		};
	}
	if (workId) {
		return {
			to: "/w/$workspaceId/work/$workId",
			params: { workspaceId, workId },
			search: viewSearch(viewMode),
		};
	}
	return {
		to: "/w/$workspaceId",
		params: { workspaceId },
		search: viewSearch(viewMode),
	};
}

export function selectionToPath(input: SelectionLocationInput): string {
	const { viewMode, workspaceId, workId, sessionThreadId, artifactId } =
		normalizeSelectionInput(input);
	if (viewMode === "start") return "/start";
	if (!workspaceId) return "/";
	const encodedWorkspace = encodeURIComponent(workspaceId);
	if (workId && sessionThreadId) {
		return `/w/${encodedWorkspace}/work/${encodeURIComponent(workId)}/session/${encodeURIComponent(sessionThreadId)}`;
	}
	if (workId && artifactId) {
		return `/w/${encodedWorkspace}/work/${encodeURIComponent(workId)}/artifact/${encodeURIComponent(artifactId)}`;
	}
	if (workId) {
		return `/w/${encodedWorkspace}/work/${encodeURIComponent(workId)}`;
	}
	return `/w/${encodedWorkspace}`;
}

export function pathToSelection(pathname: string): PathSelection {
	const segments = pathname.split("/").filter((segment) => segment.length > 0);

	if (segments[0] === "w" && segments[1]) {
		const workspaceId = decodeURIComponent(segments[1]);
		if (segments[2] === "work" && segments[3]) {
			const workId = decodeURIComponent(segments[3]);
			if (segments[4] === "session" && segments[5]) {
				const sessionThreadId = decodeURIComponent(segments[5]);
				return {
					workspaceId,
					workId,
					sessionThreadId,
					artifactId: null,
					sessionId: sessionThreadId,
				};
			}
			if (segments[4] === "artifact" && segments[5]) {
				return {
					workspaceId,
					workId,
					sessionThreadId: null,
					artifactId: decodeURIComponent(segments[5]),
					sessionId: null,
				};
			}
			return {
				workspaceId,
				workId,
				sessionThreadId: null,
				artifactId: null,
				sessionId: workId,
			};
		}
		// Backward-compatible read of the old session-first route shape.
		if (segments[2] === "s" && segments[3]) {
			const workId = decodeURIComponent(segments[3]);
			return {
				workspaceId,
				workId,
				sessionThreadId: null,
				artifactId: null,
				sessionId: workId,
			};
		}
		return {
			workspaceId,
			workId: null,
			sessionThreadId: null,
			artifactId: null,
			sessionId: null,
		};
	}

	return {
		workspaceId: null,
		workId: null,
		sessionThreadId: null,
		artifactId: null,
		sessionId: null,
	};
}

export type LocationViewInfo = {
	isStart: boolean;
	isEditor: boolean;
};

export function locationToViewInfo({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): LocationViewInfo {
	return {
		isStart: pathname === "/start",
		isEditor: (search as { view?: string }).view === "editor",
	};
}

export type LocationSelection = {
	workspaceId: string | null;
	workId: string | null;
	sessionThreadId: string | null;
	artifactId: string | null;
	// Deprecated compatibility alias for legacy shell code.
	sessionId: string | null;
	viewMode: ShellViewMode;
};

export function locationToSelection({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): LocationSelection {
	const { isStart, isEditor } = locationToViewInfo({ pathname, search });
	const { workspaceId, workId, sessionThreadId, artifactId, sessionId } =
		pathToSelection(pathname);
	const viewMode: ShellViewMode = isStart
		? "start"
		: isEditor
			? "editor"
			: "conversation";
	return {
		workspaceId,
		workId,
		sessionThreadId,
		artifactId,
		sessionId,
		viewMode,
	};
}

export function locationToSettingsPatch({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): Partial<AppSettings> {
	const { isStart } = locationToViewInfo({ pathname, search });
	if (isStart) {
		return { lastSurface: "workspace-start" };
	}
	const { workspaceId, workId } = pathToSelection(pathname);
	if (!workspaceId) {
		return {};
	}
	const patch: Partial<AppSettings> = {
		lastSurface: "workspace",
		lastWorkspaceId: workspaceId,
	};
	if (workId) {
		// Transitional persistence: store the primary work selection in the
		// legacy slot until the settings model is fully migrated.
		patch.lastSessionId = workId;
	}
	return patch;
}
