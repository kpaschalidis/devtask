import { useEffect, useRef, useState } from "react";

/**
 * Returns `true` while `active` is true, and keeps returning `true` for at
 * least `minMs` after the most recent false→true transition. Use for
 * loading indicators so a fast operation (<minMs) still shows the spinner
 * long enough to be readable instead of flashing.
 *
 * Notes:
 * - Re-activating while the min-display timer is still running just keeps
 *   the indicator on; the timer is cleared and a new hide is scheduled
 *   only after `active` goes false again.
 * - `minMs` is anchored to the most recent false→true transition, not to
 *   the component mount. A query that refetches on a 60s interval will
 *   re-trigger the min-display each refetch.
 */
export function useMinDisplayDuration(active: boolean, minMs: number): boolean {
	const [displayed, setDisplayed] = useState(active);
	const startedAtRef = useRef<number | null>(active ? performance.now() : null);

	useEffect(() => {
		if (active) {
			if (startedAtRef.current === null) {
				startedAtRef.current = performance.now();
			}
			setDisplayed(true);
			return;
		}
		if (startedAtRef.current === null) {
			setDisplayed(false);
			return;
		}
		const elapsed = performance.now() - startedAtRef.current;
		const remaining = minMs - elapsed;
		if (remaining <= 0) {
			startedAtRef.current = null;
			setDisplayed(false);
			return;
		}
		const handle = setTimeout(() => {
			startedAtRef.current = null;
			setDisplayed(false);
		}, remaining);
		return () => clearTimeout(handle);
	}, [active, minMs]);

	return displayed;
}
