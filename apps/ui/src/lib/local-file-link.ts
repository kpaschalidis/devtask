export type LocalFileLinkTarget = {
	path: string;
	line?: number;
	column?: number;
};

type ParsedHashLocation = {
	line?: number;
	column?: number;
};

const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LINE_HASH_RE = /^#L(\d+)(?:C(\d+))?$/i;
const TRAILING_LOCATION_RE = /^(.*?):(\d+)(?::(\d+))?$/;

export function parseLocalFileLink(
	href: string,
	workspaceRootPath?: string | null,
): LocalFileLinkTarget | null {
	const trimmedHref = href.trim();
	if (!trimmedHref || EXTERNAL_SCHEME_RE.test(trimmedHref)) {
		return null;
	}

	const [rawPathPart, rawHash = ""] = splitHash(trimmedHref);
	const decodedPath = safeDecode(rawPathPart);
	const hashLocation = parseHashLocation(rawHash);
	const pathWithLocation = parseTrailingLocation(decodedPath);
	const path = resolvePath(pathWithLocation.path, workspaceRootPath);

	if (!path) {
		return null;
	}

	return {
		path,
		line: pathWithLocation.line ?? hashLocation.line,
		column: pathWithLocation.column ?? hashLocation.column,
	};
}

function splitHash(href: string): [string, string?] {
	const hashIndex = href.indexOf("#");
	if (hashIndex === -1) {
		return [href];
	}
	return [href.slice(0, hashIndex), href.slice(hashIndex)];
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseHashLocation(hash: string): ParsedHashLocation {
	const match = LINE_HASH_RE.exec(hash);
	if (!match) {
		return {};
	}
	return {
		line: Number(match[1]),
		column: match[2] ? Number(match[2]) : undefined,
	};
}

function parseTrailingLocation(path: string): LocalFileLinkTarget {
	const match = TRAILING_LOCATION_RE.exec(path);
	if (!match) {
		return { path };
	}
	return {
		path: match[1],
		line: Number(match[2]),
		column: match[3] ? Number(match[3]) : undefined,
	};
}

function resolvePath(
	path: string,
	workspaceRootPath?: string | null,
): string | null {
	if (!path) {
		return null;
	}
	if (path.startsWith("/")) {
		return normalizePath(path);
	}
	if (!workspaceRootPath) {
		return null;
	}
	return normalizePath(
		`${workspaceRootPath.replace(/\/+$/, "")}/${path.replace(/^\.?\//, "")}`,
	);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}
