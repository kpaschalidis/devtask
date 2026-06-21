/**
 * Lazy preview loader for file-based `InlineBadge`s.
 *
 * Call `createFilePreviewLoader(path)` to obtain a zero-arg function that,
 * when invoked, returns a promise resolving to a `ComposerPreviewPayload`.
 * The payload is cached at the module level keyed by path, so repeated
 * hovers of the same file (across multiple badges) only trigger a single
 * read.
 *
 * The loader throws for unreadable files (binary, missing, permission
 * denied). Callers should render a "Unable to preview" frame on rejection.
 * For files that exceed `MAX_PREVIEW_BYTES`, the loader resolves with a
 * text payload containing a "too large" hint instead of reading.
 */

import { readEditorFile, statEditorFile } from "@/lib/api";
import {
	type ComposerPreviewPayload,
	inferComposerPreviewLanguage,
} from "@/lib/composer-insert";
import { basename } from "@/lib/path-util";

/** Max file size (in bytes) we attempt to read for a preview. */
const MAX_PREVIEW_BYTES = 512 * 1024; // 512 KB

/** Module-level cache: path -> in-flight or settled promise. */
const previewCache = new Map<string, Promise<ComposerPreviewPayload>>();

/** Clear the in-memory preview cache. Useful in tests. */
export function clearInlineBadgePreviewCache(): void {
	previewCache.clear();
}

export function createFilePreviewLoader(
	path: string,
): () => Promise<ComposerPreviewPayload> {
	return () => {
		const existing = previewCache.get(path);
		if (existing) return existing;

		const pending = loadFilePreview(path);
		previewCache.set(path, pending);

		// On failure, evict so the next hover gets a retry.
		pending.catch(() => {
			previewCache.delete(path);
		});

		return pending;
	};
}

async function loadFilePreview(path: string): Promise<ComposerPreviewPayload> {
	const title = basename(path);

	// Stat first so we can short-circuit huge files without loading them.
	const stat = await statEditorFile(path);
	if (!stat.exists || !stat.isFile) {
		throw new Error(`File not found or not a regular file: ${path}`);
	}
	if (stat.size !== null && stat.size > MAX_PREVIEW_BYTES) {
		const mb = (stat.size / (1024 * 1024)).toFixed(1);
		return {
			kind: "text",
			title,
			text: `File too large to preview (${mb} MB)`,
		};
	}

	// readEditorFile throws for binary / non-UTF-8 content.
	const response = await readEditorFile(path);
	const language = inferComposerPreviewLanguage(response.content);

	if (language) {
		return {
			kind: "code",
			title,
			code: response.content,
			language,
		};
	}

	return {
		kind: "text",
		title,
		text: response.content,
	};
}
