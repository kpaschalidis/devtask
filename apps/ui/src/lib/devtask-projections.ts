// Projection layer: derives view model types from raw devtask API data.
// "Project" (UI term) = workspace (backend term).
import type { DevtaskWorkListEntry } from "./devtask-api";

export type NavView = "active" | "needs-you" | "shipped";

export const NAV_VIEWS: { id: NavView; label: string }[] = [
	{ id: "active", label: "Active" },
	{ id: "needs-you", label: "Needs you" },
	{ id: "shipped", label: "Shipped" },
];

export type ViewCounts = {
	all: number;
	active: number;
	needsYou: number;
	shipped: number;
};

export function computeViewCounts(work: DevtaskWorkListEntry[]): ViewCounts {
	return {
		all: work.length,
		active: filterWorkByNavView(work, "active").length,
		needsYou: filterWorkByNavView(work, "needs-you").length,
		shipped: filterWorkByNavView(work, "shipped").length,
	};
}

export function filterWorkByNavView(
	work: DevtaskWorkListEntry[],
	navView: NavView | null,
): DevtaskWorkListEntry[] {
	if (!navView) return work;
	if (navView === "active") {
		return work.filter(
			(item) =>
				item.status.includes("running") || item.status.includes("execut"),
		);
	}
	if (navView === "needs-you") {
		return work.filter(
			(item) =>
				item.status.includes("failed") ||
				item.status.includes("blocked") ||
				item.waitingOn.toLowerCase().includes("you") ||
				item.waitingOn.toLowerCase().includes("human"),
		);
	}
	if (navView === "shipped") {
		return work.filter(
			(item) =>
				item.status.includes("done") || item.status.includes("passed"),
		);
	}
	return work;
}

// Relative time formatter for work list rows
export function formatRelativeTime(value: string | null): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 30) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

// Derive a display-friendly phase label from a work status string.
// This is a temporary projection — the backend does not yet expose phase separately.
export function statusToPhase(status: string): string {
	if (status.includes("spec")) return "spec";
	if (status.includes("plan")) return "plan";
	if (status.includes("impl") || status.includes("execut") || status.includes("running"))
		return "impl";
	if (status.includes("valid")) return "validate";
	if (status.includes("review")) return "review";
	if (status.includes("pr") || status.includes("done") || status.includes("passed"))
		return "pr";
	return status.split("-")[0] ?? status;
}
