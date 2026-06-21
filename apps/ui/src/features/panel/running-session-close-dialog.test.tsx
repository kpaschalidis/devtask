import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunningSessionCloseDialog } from "./running-session-close-dialog";

describe("RunningSessionCloseDialog", () => {
	it("renders the running-chat confirmation copy", () => {
		render(
			<RunningSessionCloseDialog
				open
				agentLabel="Claude"
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		expect(screen.getByText("Close running chat?")).toBeInTheDocument();
		expect(
			screen.getByText(
				"This chat is currently running. Closing it will cancel Claude.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Close anyway" }),
		).toBeInTheDocument();
	});

	it("blocks dismiss while loading", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();

		render(
			<RunningSessionCloseDialog
				open
				agentLabel="Codex"
				loading
				onOpenChange={onOpenChange}
				onConfirm={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});
