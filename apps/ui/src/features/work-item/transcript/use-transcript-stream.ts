import { useEffect, useMemo, useState } from "react";
import { detectTranscriptFormat } from "./detect";
import { parseTranscript } from "./parse";
import type { TranscriptEntry } from "./types";

const DEVTASK_API_BASE =
	(import.meta.env.VITE_DEVTASK_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export type TranscriptStreamState = {
	entries: TranscriptEntry[];
	rawContent: string | null;
	isConnected: boolean;
	hasContent: boolean;
	error: string | null;
};

export function useTranscriptStream(
	transcriptPath: string | null,
	provider: string | null | undefined,
	enabled: boolean,
): TranscriptStreamState {
	const [rawContent, setRawContent] = useState<string | null>(null);
	const [isConnected, setIsConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!transcriptPath || !enabled) {
			setRawContent(null);
			setIsConnected(false);
			setError(null);
			return;
		}

		setError(null);
		const url = `${DEVTASK_API_BASE}/api/transcript-stream?path=${encodeURIComponent(transcriptPath)}`;
		const es = new EventSource(url);

		const handleSnapshot = (e: MessageEvent) => {
			const data = JSON.parse(e.data as string) as { content: string };
			setRawContent(data.content);
			setIsConnected(true);
			setError(null);
		};

		es.addEventListener("snapshot", handleSnapshot);
		es.onerror = () => {
			setIsConnected(false);
			// Only set error if we never received content — transient disconnects on
			// active runs are expected and will self-heal when the server is available.
			setError((prev) => (prev === null && rawContent === null ? "Could not connect to transcript stream. The server may need to be rebuilt." : prev));
		};

		return () => {
			es.close();
			setIsConnected(false);
		};
	}, [transcriptPath, enabled]);

	const entries = useMemo(() => {
		if (!rawContent) return [];
		const format = detectTranscriptFormat(provider, rawContent);
		return parseTranscript(rawContent, format);
	}, [rawContent, provider]);

	return {
		entries,
		rawContent,
		isConnected,
		hasContent: rawContent !== null,
		error,
	};
}
