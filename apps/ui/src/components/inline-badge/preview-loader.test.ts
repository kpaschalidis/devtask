import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
	statEditorFile: vi.fn(),
	readEditorFile: vi.fn(),
}));

const { statEditorFile, readEditorFile } = await import("@/lib/api");
const mockStat = vi.mocked(statEditorFile);
const mockRead = vi.mocked(readEditorFile);

const { clearInlineBadgePreviewCache, createFilePreviewLoader } = await import(
	"./preview-loader"
);

beforeEach(() => {
	mockStat.mockReset();
	mockRead.mockReset();
	clearInlineBadgePreviewCache();
});

afterEach(() => {
	vi.clearAllMocks();
});

function okStat(size: number) {
	return {
		path: "/tmp/example.txt",
		exists: true,
		isFile: true,
		mtimeMs: 0,
		size,
	};
}

describe("createFilePreviewLoader", () => {
	it("returns a text payload for plain content", async () => {
		mockStat.mockResolvedValue(okStat(12));
		mockRead.mockResolvedValue({
			path: "/tmp/a.txt",
			content: "hello world\n",
			mtimeMs: 0,
		});

		const payload = await createFilePreviewLoader("/tmp/a.txt")();

		expect(payload).toEqual({
			kind: "text",
			title: "a.txt",
			text: "hello world\n",
		});
	});

	it("infers code language for TS-shaped content", async () => {
		mockStat.mockResolvedValue(okStat(24));
		mockRead.mockResolvedValue({
			path: "/tmp/main.ts",
			content: "const value = 1;\n",
			mtimeMs: 0,
		});

		const payload = await createFilePreviewLoader("/tmp/main.ts")();

		expect(payload).toEqual({
			kind: "code",
			title: "main.ts",
			code: "const value = 1;\n",
			language: "ts",
		});
	});

	it("short-circuits files larger than the preview cap", async () => {
		mockStat.mockResolvedValue(okStat(10 * 1024 * 1024));

		const payload = await createFilePreviewLoader("/tmp/huge.bin")();

		expect(payload.kind).toBe("text");
		expect(payload).toMatchObject({
			title: "huge.bin",
			text: expect.stringMatching(/File too large to preview/),
		});
		expect(mockRead).not.toHaveBeenCalled();
	});

	it("throws when the file is missing", async () => {
		mockStat.mockResolvedValue({
			path: "/tmp/nope.txt",
			exists: false,
			isFile: false,
			mtimeMs: null,
			size: null,
		});

		await expect(createFilePreviewLoader("/tmp/nope.txt")()).rejects.toThrow(
			/File not found/,
		);
		expect(mockRead).not.toHaveBeenCalled();
	});

	it("caches successful loads by path across instances", async () => {
		mockStat.mockResolvedValue(okStat(5));
		mockRead.mockResolvedValue({
			path: "/tmp/cached.txt",
			content: "cache",
			mtimeMs: 0,
		});

		const first = await createFilePreviewLoader("/tmp/cached.txt")();
		const second = await createFilePreviewLoader("/tmp/cached.txt")();

		expect(first).toBe(second);
		expect(mockStat).toHaveBeenCalledTimes(1);
		expect(mockRead).toHaveBeenCalledTimes(1);
	});

	it("evicts failed loads so the next hover retries", async () => {
		mockStat.mockRejectedValueOnce(new Error("boom"));

		await expect(createFilePreviewLoader("/tmp/flaky.txt")()).rejects.toThrow(
			/boom/,
		);

		mockStat.mockResolvedValueOnce(okStat(3));
		mockRead.mockResolvedValueOnce({
			path: "/tmp/flaky.txt",
			content: "ok",
			mtimeMs: 0,
		});

		const payload = await createFilePreviewLoader("/tmp/flaky.txt")();
		expect(payload).toMatchObject({ kind: "text", text: "ok" });
		expect(mockStat).toHaveBeenCalledTimes(2);
	});
});
