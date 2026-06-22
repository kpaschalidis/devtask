const DEVTASK_API_BASE =
	(import.meta.env.VITE_DEVTASK_API_BASE as string | undefined)?.replace(
		/\/$/,
		"",
	) ?? "";

export type DevtaskWorkListEntry = {
	id: string;
	title: string;
	sourceType: string;
	status: string;
	updatedAt: string;
	nextAction: string;
	waitingOn: string;
};

export type DevtaskWorkListResponse = {
	workspaceId: string | null;
	work: DevtaskWorkListEntry[];
	generatedAt: string;
};

export type DevtaskWorkArtifact = {
	label: string;
	path: string;
	exists: boolean;
};

export type DevtaskWorkInspection = {
	workId: string;
	status: string;
	artifacts: DevtaskWorkArtifact[];
	latestPhaseRuns: Array<{
		phase: string;
		repoId: string | null;
		taskId: string | null;
		status: string;
		promptPath: string;
		outputPath: string;
		filePath: string;
		provider: string;
		transportId: string | null;
		conversationId: string | null;
		providerSessionId: string | null;
		resumeTarget: string | null;
		summary: string | null;
		storageRoot: string | null;
		transcriptPath: string | null;
		artifacts: Record<string, string>;
	}>;
	livePhaseSessions: Array<{
		phase: string;
		repoId: string | null;
		taskId: string | null;
		status: string;
		tmuxSession: string;
		live: boolean;
		promptPath: string;
		outputPath: string;
	}>;
	problemTasks: Array<{
		repoId: string;
		taskId: string;
		status: string;
		reason: string | null;
		worktreePath: string;
		sessionName: string | null;
	}>;
};

export type DevtaskWorkSessionThread = {
	threadId: string;
	owner: { type: string; id: string };
	labels: string[];
	agentName: string;
	status: string;
	currentRuntimeSessionId: string | null;
	startedAt: string;
	endedAt: string | null;
	metadata: Record<string, unknown>;
};

export type DevtaskWorkDetail = {
	item: {
		id: string;
		status: string;
		createdAt: string;
		updatedAt: string;
		source: {
			type: string;
			title: string;
			body: string;
			artifact: string;
		};
	};
	status: {
		workId: string;
		orchestratorSession: {
			running: boolean;
			tmuxSession: string | null;
			runId: string | null;
		};
		gate1: { status: string; updatedAt: string } | null;
		gate2: { status: string; updatedAt: string } | null;
		validatorResults: Array<{
			repoId: string;
			status: "passed" | "failed" | "unknown";
			totalAssertions: number;
			failedAssertions: number;
		}>;
		nextAction: string | null;
	};
	diagnostics: {
		workId: string;
		waitingOn: string;
		next: string;
		missingArtifacts: string[];
		warnings: string[];
	};
	inspection: DevtaskWorkInspection;
	sessions: DevtaskWorkSessionThread[];
};

export type DevtaskSessionDetail = {
	thread: DevtaskWorkSessionThread | null;
	events: Array<Record<string, unknown>>;
	timeline: Array<Record<string, unknown>>;
	transcript: Array<{
		id: string;
		role: "agent" | "user";
		kind: "output" | "thinking" | "question" | "answer" | "user-initiated";
		content: string;
		createdAt: string;
		deliveredAt?: string;
	}>;
};

async function fetchJson<T>(pathname: string): Promise<T> {
	const response = await fetch(`${DEVTASK_API_BASE}${pathname}`, {
		headers: {
			accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${pathname}`);
	}

	return (await response.json()) as T;
}

export function loadDevtaskWorkList(): Promise<DevtaskWorkListResponse> {
	return fetchJson<DevtaskWorkListResponse>("/api/work");
}

export function loadDevtaskWorkDetail(workId: string): Promise<DevtaskWorkDetail> {
	return fetchJson<DevtaskWorkDetail>(`/api/work/${encodeURIComponent(workId)}`);
}

export function loadDevtaskSessionDetail(
	threadId: string,
): Promise<DevtaskSessionDetail> {
	return fetchJson<DevtaskSessionDetail>(
		`/api/sessions/${encodeURIComponent(threadId)}`,
	);
}
