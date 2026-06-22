import { queryOptions } from "@tanstack/react-query";
import {
	loadDevtaskSessionDetail,
	loadDevtaskWorkDetail,
	loadDevtaskWorkList,
} from "./devtask-api";

export const devtaskQueryKeys = {
	workList: ["devtask", "work"] as const,
	workDetail: (workId: string) => ["devtask", "work", workId] as const,
	sessionDetail: (threadId: string) =>
		["devtask", "session", threadId] as const,
};

export function devtaskWorkListQueryOptions() {
	return queryOptions({
		queryKey: devtaskQueryKeys.workList,
		queryFn: loadDevtaskWorkList,
		staleTime: 5_000,
	});
}

export function devtaskWorkDetailQueryOptions(workId: string) {
	return queryOptions({
		queryKey: devtaskQueryKeys.workDetail(workId),
		queryFn: () => loadDevtaskWorkDetail(workId),
		staleTime: 2_000,
	});
}

export function devtaskSessionDetailQueryOptions(threadId: string) {
	return queryOptions({
		queryKey: devtaskQueryKeys.sessionDetail(threadId),
		queryFn: () => loadDevtaskSessionDetail(threadId),
		staleTime: 2_000,
	});
}
