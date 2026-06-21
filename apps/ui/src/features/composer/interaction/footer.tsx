import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared footer for interaction panels: a right-aligned flex row separated
 * from the body by a thin border-top. Callers drop `<Button size="sm">`
 * children directly inside.
 */
type InteractionFooterProps = {
	children: ReactNode;
	className?: string;
};

export function InteractionFooter({
	children,
	className,
}: InteractionFooterProps) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-end gap-2 border-t border-border/30 px-1 pt-2",
				className,
			)}
		>
			{children}
		</div>
	);
}
