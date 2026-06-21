import type { WorkspaceGroup } from "@/lib/api";

/**
 * Compute the macOS Dock badge count from the current (non-archived) workspace
 * groups. Sums `unreadSessionCount` across every visible workspace.
 * `workspaceUnread` is purely derived from sessions on the backend, so it adds
 * no information here and is intentionally ignored.
 */
export function selectUnreadSessionCount(
	groups: WorkspaceGroup[] | undefined | null,
): number {
	if (!groups) return 0;
	let total = 0;
	for (const group of groups) {
		for (const row of group.rows) {
			total += row.unreadSessionCount ?? 0;
		}
	}
	return total;
}
