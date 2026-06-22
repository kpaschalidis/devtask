import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	stripSearchParams,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
	locationToSelection,
	locationToViewInfo,
	pathToSelection,
	selectionToLocation,
	selectionToPath,
} from "./location-mapping";

describe("selectionToPath", () => {
	it("maps the start surface to /start", () => {
		expect(
			selectionToPath({
				viewMode: "start",
				workspaceId: null,
				workId: null,
			}),
		).toBe("/start");
	});

	it("maps workspace + work to /w/<ws>/work/<id>", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				workId: "work-1",
			}),
		).toBe("/w/ws1/work/work-1");
	});

	it("maps a nested session thread under work", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				workId: "work-1",
				sessionThreadId: "thread-1",
			}),
		).toBe("/w/ws1/work/work-1/session/thread-1");
	});

	it("maps a nested artifact under work", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				workId: "work-1",
				artifactId: "plan",
			}),
		).toBe("/w/ws1/work/work-1/artifact/plan");
	});

	it("preserves the boot index for non-start with no workspace", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: null,
				workId: null,
			}),
		).toBe("/");
	});

	it("treats legacy sessionId input as a work id during migration", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				sessionId: "legacy-session",
			}),
		).toBe("/w/ws1/work/legacy-session");
	});
});

describe("selectionToLocation", () => {
	it("maps a work selection to the work route", () => {
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: "ws1",
				workId: "work-1",
			}),
		).toEqual({
			to: "/w/$workspaceId/work/$workId",
			params: { workspaceId: "ws1", workId: "work-1" },
			search: { view: "conversation" },
		});
	});

	it("maps a work session thread selection", () => {
		expect(
			selectionToLocation({
				viewMode: "editor",
				workspaceId: "ws1",
				workId: "work-1",
				sessionThreadId: "thread-1",
			}),
		).toEqual({
			to: "/w/$workspaceId/work/$workId/session/$threadId",
			params: { workspaceId: "ws1", workId: "work-1", threadId: "thread-1" },
			search: { view: "editor" },
		});
	});

	it("maps a work artifact selection", () => {
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: "ws1",
				workId: "work-1",
				artifactId: "spec",
			}),
		).toEqual({
			to: "/w/$workspaceId/work/$workId/artifact/$artifactId",
			params: { workspaceId: "ws1", workId: "work-1", artifactId: "spec" },
			search: { view: "conversation" },
		});
	});
});

describe("pathToSelection", () => {
	it("parses /w/<ws>/work/<id>", () => {
		expect(pathToSelection("/w/ws1/work/work-1")).toEqual({
			workspaceId: "ws1",
			workId: "work-1",
			sessionThreadId: null,
			artifactId: null,
			sessionId: "work-1",
		});
	});

	it("parses /w/<ws>/work/<id>/session/<thread>", () => {
		expect(pathToSelection("/w/ws1/work/work-1/session/thread-1")).toEqual({
			workspaceId: "ws1",
			workId: "work-1",
			sessionThreadId: "thread-1",
			artifactId: null,
			sessionId: "thread-1",
		});
	});

	it("parses /w/<ws>/work/<id>/artifact/<artifact>", () => {
		expect(pathToSelection("/w/ws1/work/work-1/artifact/plan")).toEqual({
			workspaceId: "ws1",
			workId: "work-1",
			sessionThreadId: null,
			artifactId: "plan",
			sessionId: null,
		});
	});

	it("parses the old /s/<session> route for backward compatibility", () => {
		expect(pathToSelection("/w/ws1/s/session-1")).toEqual({
			workspaceId: "ws1",
			workId: "session-1",
			sessionThreadId: null,
			artifactId: null,
			sessionId: "session-1",
		});
	});
});

describe("locationToSelection", () => {
	it("derives work-first selection from a work route", () => {
		expect(
			locationToSelection({
				pathname: "/w/ws1/work/work-1",
				search: {},
			}),
		).toEqual({
			workspaceId: "ws1",
			workId: "work-1",
			sessionThreadId: null,
			artifactId: null,
			sessionId: "work-1",
			viewMode: "conversation",
		});
	});
});

describe("locationToViewInfo", () => {
	it("flags /start as start and ?view=editor as editor", () => {
		expect(locationToViewInfo({ pathname: "/start", search: {} })).toEqual({
			isStart: true,
			isEditor: false,
		});
		expect(
			locationToViewInfo({
				pathname: "/w/ws1/work/work-1",
				search: { view: "editor" },
			}),
		).toEqual({
			isStart: false,
			isEditor: true,
		});
	});
});

describe("router round-trip", () => {
	it("round-trips the work route with default conversation view stripped", async () => {
		const memoryHistory = createMemoryHistory({ initialEntries: ["/"] });
		const rootRoute = createRootRoute();
		const workspaceRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/w/$workspaceId/work/$workId",
			component: () => null,
			validateSearch: (search: Record<string, unknown>) => ({
				view: search.view === "editor" ? "editor" : "conversation",
			}),
			search: { middlewares: [stripSearchParams({ view: "conversation" })] },
		});
		const routeTree = rootRoute.addChildren([workspaceRoute]);
		const router = createRouter({ routeTree, history: memoryHistory });

		await router.navigate({
			to: "/w/$workspaceId/work/$workId",
			params: { workspaceId: "ws1", workId: "work-1" },
			search: { view: "conversation" },
		});

		expect(router.state.location.pathname).toBe("/w/ws1/work/work-1");
		expect(router.state.location.search).toEqual({});
	});
});
