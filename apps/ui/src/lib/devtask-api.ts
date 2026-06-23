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
	workspaceName: string | null;
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
		promptPath: string | null;
		outputPath: string;
		filePath: string | null;
		provider: string | null;
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

export type DevtaskWorkGraphDependency = {
	task: string;
	type: string;
	reason: string | null;
};

export type DevtaskWorkGraphTask = {
	id: string;
	repoId: string;
	featureId: string | null;
	goal: string;
	owns: string[];
	dependencies: DevtaskWorkGraphDependency[];
};

export type DevtaskWorkGraphFeature = {
	id: string;
	title: string;
	taskIds: string[];
	validationRequired: boolean;
};

export type DevtaskWorkGraph = {
	schemaVersion: number;
	workId: string;
	kind: "feature" | "bugfix" | "refactor";
	tasks: DevtaskWorkGraphTask[];
	features: DevtaskWorkGraphFeature[];
	openQuestions: string[];
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
		gate1: { status: string; message: string | null; updatedAt: string } | null;
		gate2: { status: string; message: string | null; updatedAt: string } | null;
		validatorResults: Array<{
			repoId: string;
			status: "passed" | "failed" | "unknown";
			totalAssertions: number;
			failedAssertions: number;
			assertions: Array<{
				id: string;
				status: "passed" | "failed" | "skipped";
				evidence: string;
				attribution: "spec-gap" | "implementation-gap" | "environment" | "wrong-repo" | "inconclusive" | null;
				attributionReason: string | null;
			}>;
		}>;
		nextAction: string | null;
	};
	diagnostics: {
		workId: string;
		waitingOn: string;
		next: string;
		missingArtifacts: string[];
		warnings: string[];
		tasks: Array<{
			repoId: string;
			taskId: string;
			status: string;
			branch: string;
			prUrl: string | null;
			resultSummary: string | null;
			failCount: number;
			maxRetries: number;
			waitingOn: string;
			reason: string;
			next: string;
			missingArtifacts: string[];
		}>;
	};
	inspection: DevtaskWorkInspection;
	sessions: DevtaskWorkSessionThread[];
	graph: DevtaskWorkGraph | null;
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

export async function openDevtaskFile(filePath: string): Promise<void> {
	await fetch(`${DEVTASK_API_BASE}/api/open-path`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: filePath }),
	});
}

export type DevtaskFileEntry = { name: string; path: string; isDirectory: boolean };
export type DevtaskFileContent =
	| { type: "file"; path: string; content: string }
	| { type: "directory"; path: string; entries: DevtaskFileEntry[] };

export function loadDevtaskFileContent(filePath: string): Promise<DevtaskFileContent> {
	return fetchJson(`/api/file-content?path=${encodeURIComponent(filePath)}`);
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
